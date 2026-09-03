# Hosted drive_upload base64 (feat/hosted-drive-upload-base64)

- **Hosted Cloud Run** (`isHostedHttp`): `drive_upload` accepts `contentBase64` + `filename` (+ optional mimeType, parentFolderId, convertTo, account). Bytes go straight to Drive `files.create` — no desk filesystem.
- **Desk/stdio**: `localPath` / `createReadStream` still supported; `contentBase64` also accepted and preferred when provided.
- **Hosted + only localPath**: clear error to pass `contentBase64` (does not pretend to read a laptop/box path).
- **Hosted + both**: prefer `contentBase64`.
- Shared: `resolveDriveUploadSource`, `decodeContentBase64`, `hostedUploadRequiresBase64Message`, `deskUploadNeedsLocalPathMessage`. Prefer `contentBase64` whenever provided; media body uses `Readable.from(buffer)`.
- No Cloud Run deploy in this take. HAL rebuilds after merge.

# Hosted return-bytes for downloads (fix/hosted-return-bytes)

- **Hosted Cloud Run** (`isHostedHttp`: `MCP_HOSTED=1` / `K_SERVICE`): `gmail_download_attachment`, `drive_download`, `drive_export` return `{ filename, mimeType, size, encoding: "base64", data }` in the MCP tool result. Writing `savePath` on the container is useless to Grok Bot agents.
- **Desk/stdio**: unchanged — require `savePath`, write file, return path (gmail text / drive JSON).
- **Hosted + savePath**: still return bytes; optional `note` that savePath is not applicable. Do not fail.
- Shared helpers: `hostedBytesPayload`, `mcpJsonResult`, `deskSavePathRequiredMessage` in `src/hosted.ts`.
- No Cloud Run deploy in this take. HAL rebuilds after merge.

# Gmail attachments (feat/gmail-attachments)

- **Drive `driveFileId` is the hosted path.** Cloud Run fetches bytes with Drive `files.get alt=media` on the same Google account. Upload on the desk (`drive_upload`), then pass the file id to `gmail_send` / `gmail_create_draft`.
- **Local `path` is desktop-only.** Hosted Cloud Run cannot see laptop filesystems. A missing path returns a clear error that hosted Cloud Run cannot see laptop paths. Use `driveFileId` or `messageId`+`attachmentId` instead of `/home/...` on the hosted server.
- **Downloads on hosted now return base64** (see above). Desk `savePath` unchanged.
- **Do not send the Taddeo rental PDF.**
