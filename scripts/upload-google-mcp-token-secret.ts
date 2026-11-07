#!/usr/bin/env node
/**
 * One-shot desk → Secret Manager upload for one alias's encrypted `*.enc`.
 *
 *   mcp-google-multi upload-sm --account <alias> --project myflow-260730
 *
 * Does not remint Google OAuth. Does not touch other aliases.
 * Never prints token / enc / MASTER_KEY.
 *
 * Interim operator pin if a comment must name a project: myflow-260730.
 */
import { runUploadSmCli } from '../src/token-secret.js';

const code = await runUploadSmCli(process.argv.slice(2));
process.exit(code);
