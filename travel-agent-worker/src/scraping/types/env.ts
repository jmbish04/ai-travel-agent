export interface ScraperEnv extends Env {
  BROWSER: Fetcher;
  SCRAPED_DATA: R2Bucket;
  CACHE: KVNamespace;
  DB: D1Database;
  ENVIRONMENT?: string;
}

export interface StorageBindings {
  SCRAPED_DATA: R2Bucket;
  DB: D1Database;
}
