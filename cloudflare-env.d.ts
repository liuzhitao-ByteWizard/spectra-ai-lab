declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    TASK_B_PURGE_KEY?: string;
    TASK_B_PURGE_USER_ID?: string;
  }
}
