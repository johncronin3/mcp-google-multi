# Gmail attachments (feat/gmail-attachments)

- **Drive `driveFileId` is the hosted path.** Cloud Run fetches bytes with Drive `files.get alt=media` on the same Google account. Upload on the desk (`drive_upload`), then pass the file id to `gmail_send` / `gmail_create_draft`.
- **Local `path` is desktop-only.** Hosted Cloud Run cannot see laptop filesystems. A missing path returns a clear error that hosted Cloud Run cannot see laptop paths. Use `driveFileId` or `messageId`+`attachmentId` instead of `/home/...` on the hosted server.
- **This take does not add a "save to grok box" download path.** Hosted Cloud Run cannot write `/workspace` or `/home/box`. `gmail_download_attachment` still takes `savePath` on the MCP disk (desktop); left unchanged.
- **Do not send the Taddeo rental PDF.**
