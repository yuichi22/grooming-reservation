// Callable Cloud Functions のクライアントラッパ (§2/§4)。
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import type { StaffRole } from './types';

export const createTenant = httpsCallable<
  { tenantId: string; name: string; plan?: string },
  { tenantId: string }
>(functions, 'createTenant');

export const setStaffRole = httpsCallable<
  { tenantId: string; targetUid: string; name: string; role: StaffRole },
  { tenantId: string; targetUid: string; role: StaffRole }
>(functions, 'setStaffRole');
