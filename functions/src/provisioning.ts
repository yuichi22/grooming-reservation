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
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onRequest, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
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
      res.json({ ok: true, alreadyProvisioned: true, groomTenantId: existing.data()?.groomTenantId });
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
    await db.runTransaction(async (tx) => {
      const [linkSnap, tenantSnap] = await Promise.all([tx.get(linkRef), tx.get(tenantRef)]);
      if (linkSnap.exists) throw new Error('already-provisioned');
      if (tenantSnap.exists) throw new Error('tenant-id-taken');
      tx.set(tenantRef, {
        name: spaceName,
        plan: 'standard',
        status: 'active',
        lineConfig: { ...EMPTY_LINE_CONFIG },
        settings: { ...DEFAULT_SETTINGS },
        coreTenantId,
        coreSpaceId,
        source: 'core-provision',
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(linkRef, {
        coreTenantId,
        coreSpaceId,
        groomTenantId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    console.log(`[provisionTenantForSpace] created groom tenant ${groomTenantId} for ${coreTenantId}/${coreSpaceId}`);
    res.json({ ok: true, groomTenantId });
  } catch (e) {
    if ((e as Error).message === 'already-provisioned') {
      const again = await linkRef.get();
      res.json({ ok: true, alreadyProvisioned: true, groomTenantId: again.data()?.groomTenantId });
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
