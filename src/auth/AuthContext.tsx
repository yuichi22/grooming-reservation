import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from '../firebase';
import type { StaffRole } from '../lib/types';

/** custom claims から取り出すアプリ権限 (§2) */
export interface AppClaims {
  tenantId: string | null;
  role: StaffRole | null;
  superAdmin: boolean;
}

interface AuthState {
  user: User | null;
  claims: AppClaims;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const EMPTY_CLAIMS: AppClaims = { tenantId: null, role: null, superAdmin: false };

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<AppClaims>(EMPTY_CLAIMS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (u) {
        const token = await u.getIdTokenResult();
        setClaims({
          tenantId: (token.claims.tenantId as string) ?? null,
          role: (token.claims.role as StaffRole) ?? null,
          superAdmin: token.claims.superAdmin === true,
        });
      } else {
        setClaims(EMPTY_CLAIMS);
      }
      setUser(u);
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      claims,
      loading,
      login: async (email, password) => {
        await signInWithEmailAndPassword(auth, email, password);
      },
      logout: async () => {
        await signOut(auth);
      },
    }),
    [user, claims, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** admin もしくは superAdmin か */
export function useIsAdmin(): boolean {
  const { claims } = useAuth();
  return claims.role === 'admin' || claims.superAdmin;
}
