import { useAuth } from '../auth/AuthContext';

export default function DashboardPage() {
  const { claims } = useAuth();
  return (
    <section>
      <h1>ダッシュボード</h1>
      <p className="muted">M2: スタッフ・管理者の管理画面。</p>
      {!claims.tenantId && !claims.superAdmin && (
        <p className="error">
          このアカウントにテナント(tenantId)が割り当てられていません。管理者に setStaffRole の実行を依頼してください。
        </p>
      )}
      {claims.superAdmin && !claims.tenantId && (
        <p className="muted">superAdmin としてログイン中（テナント選択は今後のマイルストーンで実装）。</p>
      )}
      <ul>
        <li>カルテ: 犬の情報・施術履歴の閲覧/編集（trimmer 可 §7）</li>
        <li>メニュー / スタッフ / 設定: 管理者(admin)のみ（§2）</li>
      </ul>
    </section>
  );
}
