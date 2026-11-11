import type { Express, Request } from 'express';
import { LoginRow, Store } from './db.js';
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
/** The login (registered or guest) behind this request's cookie, if any. */
export declare function currentLogin(req: Request, store: Store): LoginRow | undefined;
export declare function registerAccountRoutes(app: Express, store: Store): void;
//# sourceMappingURL=auth.d.ts.map