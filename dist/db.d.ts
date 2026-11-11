/**
 * SQLite store for accounts, logins, sessions, prompts and irreversible incidents.
 *
 *  - users               registered accounts (username + salted scrypt hash)
 *  - logins              one row per signed-in browser (cookie token, stored hashed).
 *                        user_id NULL = guest.
 *  - sessions            a run of prompts. Ends on logout or "Close session".
 *                        Running cost totals live on the row.
 *  - prompts             every Ask click in a session, with its cost
 *  - prompt_incidents    which incidents each prompt surfaced (IDs only; the
 *                        incident data stays in ai_incidents.json)
 *  - user_irreversible   irreversible incidents, per user. Survives sessions AND
 *                        history deletion. Never written for guests.
 *
 * Guest data is deleted when their session ends (and wiped at server start).
 */
export interface UserRow {
    id: number;
    username: string;
    password_hash: string;
}
export interface LoginRow {
    token_hash: string;
    user_id: number | null;
    expires_at: string;
}
export interface SessionSummary {
    id: number;
    promptCount: number;
    totalEnergyWh: number;
    totalWaterMl: number;
    totalCarbonG: number;
}
export interface PromptInput {
    text: string;
    modelId: string;
    modelLabel: string;
    size: string;
    energyWh: number | null;
    waterMl: number | null;
    carbonG: number | null;
    envJson: string;
}
export interface SessionDetail extends SessionSummary {
    prompts: {
        id: number;
        text: string;
        modelId: string;
        createdAt: string;
    }[];
    surfaced: number[];
    last: {
        text: string;
        matched: number[];
        environmental: unknown;
    } | null;
}
export declare class Store {
    private db;
    private stmts;
    constructor(file: string);
    private s;
    createUser(username: string, passwordHash: string): UserRow | null;
    getUserByUsername(username: string): UserRow | undefined;
    getUserById(id: number): {
        id: number;
        username: string;
    } | undefined;
    createLogin(tokenHash: string, userId: number | null, expiresAt: string): LoginRow;
    /** The login for a token hash, or undefined if unknown/expired. */
    getLogin(tokenHash: string): LoginRow | undefined;
    /** Logout: end the session (guests: delete their data) and drop the login. */
    logout(login: LoginRow): void;
    private openSessionRow;
    private summary;
    getOpenSession(login: LoginRow): SessionSummary | undefined;
    /** The open session, starting one on first use. */
    ensureSession(login: LoginRow): SessionSummary;
    sessionSummary(id: number): SessionSummary;
    /** Session end. Registered users keep the record; guests' data is deleted. */
    endSession(login: LoginRow): void;
    /** Delete all prompt history. Irreversible incidents are NOT touched. */
    deleteHistory(login: LoginRow): void;
    /** Record a prompt, its matches, and the running totals in one transaction. */
    recordPrompt(sessionId: number, p: PromptInput, matches: {
        id: number;
        similarity: number;
    }[]): SessionSummary;
    /** Everything needed to rebuild the page after a reload. */
    sessionDetail(sessionId: number): SessionDetail;
    lifetime(userId: number): {
        sessions: any;
        prompts: any;
        energyWh: any;
        waterMl: any;
        carbonG: any;
    };
    /** Persist irreversible incidents for a user. Returns the ones that were new. */
    addIrreversible(userId: number, ids: number[]): number[];
    getIrreversible(userId: number): number[];
    purgeExpired(): void;
    /** Guest data does not outlive the server process. */
    private purgeOnStart;
}
//# sourceMappingURL=db.d.ts.map