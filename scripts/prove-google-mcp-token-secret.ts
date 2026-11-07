#!/usr/bin/env node
/**
 * Prove path for Secret Manager secret `google-mcp-token-<alias>`.
 *
 * Default: dry-run, no network.
 * Requires explicit `--project` and `--alias`. Does not call `gcloud config get-value project`.
 *
 *   npm run prove:google-mcp-token-secret -- --project <gcp-project> --alias <alias>
 *
 * `--live` writes a new version (byte-copy of latest) and reads back
 * name / createTime / etag only — never the payload. NOT for this PR.
 * Do not pass --live until John says so. No Cloud Run deploy. No Google remint.
 *
 * Interim operator pin if a comment must name a project: myflow-260730.
 */
import { runProveCli } from '../src/token-secret-prove.js';

const code = await runProveCli(process.argv.slice(2));
process.exit(code);
