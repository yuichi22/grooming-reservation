// provisioning.ts
// Akuto Core からのテナント自動プロビジョニング受け口（groom版）。
// Core拠点で groom アプリが有効化されると、Coreトリガーが provisionTenantForSpace を叩き、
// 対応する groom テナントを自動作成して coreTenantId/coreSpaceId で紐付ける。
// 管理者は provisionGroomAdmin（ポータルからメール指定の招待）で登録する。
// custom claims は1ユーザー=1テナントのため、拠点(=groomテナント)ごとに別メールが必要。
// 認証: Authorization: Bearer <CRM_WEBHOOK_SECRET>（CRM/POS会計連携と同じ第一者共有シークレット）
// 冪等: coreLinks/{coreTenantId__coreSpaceId} に作成済み groomTenantId を記録し、再送は既存を返す。
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, onRequest, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SETTINGS, EMPTY_LINE_CONFIG } from './tenantDefaults.js';

// ESMではimportが本体より先に評価されるため、index.ts の initializeApp() を待たず
// このモジュールが先に読まれるケースがある。自衛的に初期化する。
if (!getApps().length) initializeApp();
const db = getFirestore();
const auth = getAuth();

const str = (v: unknown) => String(v ?? '').trim();

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

const checkBearer = (req: Request): boolean => {
  const secret = str(process.env.CRM_WEBHOOK_SECRET);
  const authz = req.get('authorization') ?? '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : '';
  return Boolean(secret) && safeEqual(bearer, secret);
};

// groomテナントIDの形式（Firestore doc id 兼 各所の識別子。slug と同系の英小文字系）
const TENANT_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

const INVITE_TTL_DAYS = 30;

// 管理者登録URL（POSと同じセルフ登録方式）。base は .env.<projectId> の PROVISION_BASE_URL。
const buildAdminInviteUrl = (groomTenantId: string, code: string): string | null => {
  const base = str(process.env.PROVISION_BASE_URL);
  if (!base) return null;
  return `${base}/register?tenant=${encodeURIComponent(groomTenantId)}&invite=${encodeURIComponent(code)}`;
};

// 管理者登録の完了を Core の拠点(provision.groom.admin)へ書き戻す（ポータル表示用）
const notifyCoreAdminRegistered = async (
  coreTenantId: string,
  coreSpaceId: string,
  adminEmail: string,
  adminName: string
): Promise<void> => {
  const url = str(process.env.CORE_PROVISION_UPDATE_URL);
  const secret = str(process.env.CRM_WEBHOOK_SECRET);
  if (!url || !secret) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ app: 'groom', tenantId: coreTenantId, spaceId: coreSpaceId, adminEmail, adminName }),
    });
    if (!res.ok) console.warn('[notifyCoreAdminRegistered] Core応答NG:', res.status);
  } catch (e) {
    console.warn('[notifyCoreAdminRegistered] Core接続失敗:', (e as Error).message);
  }
};

/** Core拠点に対応する groom テナントを自動作成（Coreトリガー専用・Bearer） */
export const provisionTenantForSpace = onRequest({ region: 'asia-northeast1', cors: false, invoker: 'public' }, async (req: Request, res: Response) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const coreTenantId = str(body.tenantId);
  const coreSpaceId = str(body.spaceId);
  const spaceName = str(body.spaceName) || '(拠点名未設定)';
  const slug = str(body.slug).toLowerCase();
  if (!coreTenantId || !coreSpaceId) {
    res.status(400).json({ ok: false, error: 'tenantId and spaceId required' });
    return;
  }

  const linkRef = db.collection('coreLinks').doc(`${coreTenantId}__${coreSpaceId}`);

  try {
    const existing = await linkRef.get();
    if (existing.exists) {
      res.json({
        ok: true,
        alreadyProvisioned: true,
        groomTenantId: existing.data()?.groomTenantId,
        inviteUrl: existing.data()?.inviteUrl ?? null,
      });
      return;
    }

    // テナントID: 拠点slug優先（例 groom-test）。無い/衝突時は sp-<spaceId> 系で回避。
    const candidates: string[] = [];
    if (TENANT_ID_RE.test(slug)) candidates.push(slug);
    const fallback = `sp-${coreSpaceId.toLowerCase()}`.slice(0, 40);
    if (TENANT_ID_RE.test(fallback)) candidates.push(fallback);
    for (let i = 2; i <= 4; i += 1) if (candidates[0]) candidates.push(`${candidates[0]}-${i}`);

    let groomTenantId: string | null = null;
    for (const cand of candidates) {
      const snap = await db.collection('tenants').doc(cand).get();
      if (!snap.exists) {
        groomTenantId = cand;
        break;
      }
    }
    if (!groomTenantId) {
      res.status(409).json({ ok: false, error: 'no available tenantId' });
      return;
    }

    const tenantRef = db.collection('tenants').doc(groomTenantId);
    // 管理者登録URL（POSと同じ「リンクを開いて本人がメール・パスワードを決める」方式）
    const inviteCode = randomBytes(16).toString('hex');
    const inviteUrl = buildAdminInviteUrl(groomTenantId, inviteCode);

    // 共有LINE設定（platform/lineDefaults）を複製。未設定テナントはLINE通知が
    // skipped になるため、既定で共有OAのトークン等を引き継ぐ（自前OA導入時に上書き可）。
    const defaultsSnap = await db.doc('platform/lineDefaults').get();
    const shared = defaultsSnap.exists ? defaultsSnap.data() ?? {} : {};
    const lineDefaults: Record<string, string> = {};
    for (const k of ['messagingChannelAccessToken', 'providerId', 'miniAppChannelId', 'messagingApiChannelId', 'liffId', 'addFriendUrl']) {
      const v = str((shared as Record<string, unknown>)[k]);
      if (v) lineDefaults[k] = v;
    }
    await db.runTransaction(async (tx) => {
      const [linkSnap, tenantSnap] = await Promise.all([tx.get(linkRef), tx.get(tenantRef)]);
      if (linkSnap.exists) throw new Error('already-provisioned');
      if (tenantSnap.exists) throw new Error('tenant-id-taken');
      tx.set(tenantRef, {
        name: spaceName,
        plan: 'standard',
        status: 'active',
        lineConfig: { ...EMPTY_LINE_CONFIG, ...lineDefaults },
        settings: { ...DEFAULT_SETTINGS },
        coreTenantId,
        coreSpaceId,
        source: 'core-provision',
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(tenantRef.collection('adminInvites').doc(inviteCode), {
        status: 'active',
        source: 'core-provision',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      });
      tx.set(linkRef, {
        coreTenantId,
        coreSpaceId,
        groomTenantId,
        inviteUrl,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    console.log(`[provisionTenantForSpace] created groom tenant ${groomTenantId} for ${coreTenantId}/${coreSpaceId}`);
    res.json({ ok: true, groomTenantId, inviteUrl });
  } catch (e) {
    if ((e as Error).message === 'already-provisioned') {
      const again = await linkRef.get();
      res.json({
        ok: true,
        alreadyProvisioned: true,
        groomTenantId: again.data()?.groomTenantId,
        inviteUrl: again.data()?.inviteUrl ?? null,
      });
      return;
    }
    console.error('[provisionTenantForSpace] error:', e);
    res.status(500).json({ ok: false, error: (e as Error).message || 'internal error' });
  }
});

/** groomテナントの管理者をメール指定で招待（ポータル→Core経由・Bearer）。
 *  inviteStaff と同じ手順（Authユーザー用意→claims→staff doc→パスワード設定リンク）を
 *  サーバー間認証で行う。再実行はリンク再発行として機能する（冪等）。 */
export const provisionGroomAdmin = onRequest({ region: 'asia-northeast1', cors: false, invoker: 'public' }, async (req: Request, res: Response) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const groomTenantId = str(body.groomTenantId);
  const email = str(body.email).toLowerCase();
  const name = str(body.name);
  if (!groomTenantId || !email.includes('@') || !name) {
    res.status(400).json({ ok: false, error: 'groomTenantId, email, name required' });
    return;
  }

  try {
    const tenantSnap = await db.collection('tenants').doc(groomTenantId).get();
    if (!tenantSnap.exists) {
      res.status(404).json({ ok: false, error: 'tenant not found' });
      return;
    }

    // 既存ユーザーを探し、無ければ作成（パスワード未設定→設定リンクで本人が決める）
    let user;
    let created = false;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      user = await auth.createUser({ email });
      created = true;
    }

    if (user.customClaims?.superAdmin === true) {
      res.status(409).json({ ok: false, error: 'cannot-assign-super-admin' });
      return;
    }
    const existingTenant = user.customClaims?.tenantId as string | undefined;
    if (existingTenant && existingTenant !== groomTenantId) {
      // 1ユーザー=1テナント制約。別拠点用には +エイリアス等の別メールを案内する。
      res.status(409).json({ ok: false, error: 'email-belongs-to-other-tenant' });
      return;
    }

    await auth.setCustomUserClaims(user.uid, { tenantId: groomTenantId, role: 'admin' });
    await db
      .collection('tenants')
      .doc(groomTenantId)
      .collection('staff')
      .doc(user.uid)
      .set({ name, email, role: 'admin', active: true, firebaseUid: user.uid }, { merge: true });

    let resetLink: string | null = null;
    try {
      resetLink = await auth.generatePasswordResetLink(email);
    } catch {
      resetLink = null;
    }

    console.log(`[provisionGroomAdmin] ${groomTenantId} admin=${email} created=${created}`);
    res.json({ ok: true, uid: user.uid, email, created, resetLink });
  } catch (e) {
    console.error('[provisionGroomAdmin] error:', e);
    res.status(500).json({ ok: false, error: (e as Error).message || 'internal error' });
  }
});

/** 管理者のセルフ登録（POSの /register と同方式）。
 *  ポータルに表示される管理者登録URL(?tenant&invite)から、本人がメール・氏名・パスワードを
 *  決めて登録する。招待コード(adminInvites, source=core-provision)が有効な間だけ通る。
 *  完了時に Core の拠点(provision.groom.admin)へ書き戻してポータル表示を切り替える。 */
export const registerGroomAdmin = onCall(
  { region: 'asia-northeast1' },
  async (request) => {
    const d = (request.data ?? {}) as Record<string, unknown>;
    const groomTenantId = str(d.tenantId);
    const inviteCode = str(d.inviteCode);
    const email = str(d.email).toLowerCase();
    const name = str(d.name);
    const password = String(d.password ?? '');
    if (!groomTenantId || !inviteCode || !email.includes('@') || !name) {
      throw new HttpsError('invalid-argument', '入力内容を確認してください。');
    }
    if (password.length < 6) {
      throw new HttpsError('invalid-argument', 'パスワードは6文字以上で入力してください。');
    }

    const tenantRef = db.collection('tenants').doc(groomTenantId);
    const inviteRef = tenantRef.collection('adminInvites').doc(inviteCode);
    const [tenantSnap, inviteSnap] = await Promise.all([tenantRef.get(), inviteRef.get()]);
    if (!tenantSnap.exists) throw new HttpsError('not-found', '店舗が見つかりません。');
    const invite = inviteSnap.exists ? inviteSnap.data() ?? {} : null;
    const expired = invite?.expiresAt?.toDate?.() <= new Date();
    if (!invite || invite.source !== 'core-provision' || invite.status !== 'active' || expired) {
      throw new HttpsError('failed-precondition', 'この登録リンクは無効です。ポータルから再発行してください。');
    }

    // 既存ユーザー(パスワード未設定の招待済み等)は取り込み、無ければ新規作成
    let user;
    let created = false;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      user = await auth.createUser({ email, password, displayName: name });
      created = true;
    }
    if (user.customClaims?.superAdmin === true) {
      throw new HttpsError('failed-precondition', 'このメールアドレスは使用できません。');
    }
    const existingTenant = user.customClaims?.tenantId as string | undefined;
    if (existingTenant && existingTenant !== groomTenantId) {
      throw new HttpsError(
        'failed-precondition',
        'このメールアドレスは別の店舗に登録済みです。店舗ごとに別のメールアドレス（例: name+店舗名@gmail.com）をご利用ください。'
      );
    }
    if (!created) {
      await auth.updateUser(user.uid, { password, displayName: name });
    }

    await auth.setCustomUserClaims(user.uid, { tenantId: groomTenantId, role: 'admin' });
    await tenantRef.collection('staff').doc(user.uid).set(
      { name, email, role: 'admin', active: true, firebaseUid: user.uid },
      { merge: true }
    );
    await inviteRef.set(
      { status: 'used', usedBy: user.uid, usedAt: FieldValue.serverTimestamp(), email },
      { merge: true }
    );

    const t = tenantSnap.data() ?? {};
    const coreTenantId = str(t.coreTenantId);
    const coreSpaceId = str(t.coreSpaceId);
    if (coreTenantId && coreSpaceId) {
      await notifyCoreAdminRegistered(coreTenantId, coreSpaceId, email, name);
    }

    console.log(`[registerGroomAdmin] ${groomTenantId} admin=${email} created=${created}`);
    return { ok: true, email };
  }
);
