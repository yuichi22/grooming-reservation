// tenantDefaults.ts
// テナント新規作成時の既定値。index.ts(createTenant) と provisioning.ts(Core自動作成) で共用。
export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Tokyo',
  businessHours: [{ start: '09:00', end: '19:00' }],
  bufferMin: 10,
  workTimeOptions: [50, 80, 110],
  cancelDeadlineHours: 24, // §11 キャンセル締切（既定: 前日同時刻）
};

export const EMPTY_LINE_CONFIG = {
  providerId: '',
  miniAppChannelId: '',
  messagingApiChannelId: '',
  liffId: '',
};
