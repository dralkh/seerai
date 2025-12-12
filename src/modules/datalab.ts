import { config } from "../../package.json";

interface DatalabResponse {
    success: boolean;
    error?: string;
    request_id?: string;
    request_check_url?: string;
}

interface DatalabPolledResult {
    status: "complete" | "processing" | "failed";
    output_format?: string;
    markdown?: string;
    images?: Record<string, string>;
    metadata?: any;
    error?: string;
    page_count?: number;
    success?: boolean;
}

export class DataLabService {
    private apiKey: string;
    private apiUrl = "https://www.datalab.to/api/v1";

    constructor() {
        this.apiKey = Zotero.Prefs.get(`${config.prefsPrefix}.datalabApiKey`) as string;
    }

    private getAuthHeaders(): Record<string, string> {
        return {
            "X-Api-Key": this.apiKey,
        };
    }

    /**
     * Build a multipart/form-data body manually for Cloud DataLab API.
     * Returns { body: Uint8Array, contentType: string }
     */
    private buildMultipartBody(fileData: Uint8Array, fileName: string, forceOcr: boolean, useLlm: boolean): { body: Uint8Array, contentType: string } {
        const boundary = "----ZoteroDataLabBoundary" + Date.now();
        const encoder = new TextEncoder();

        // Build the parts as strings and binary
        let preFile = "";
        preFile += `--${boundary}\r\n`;
        preFile += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
        preFile += `Content-Type: application/pdf\r\n\r\n`;

        let postFile = "";
        // force_ocr parameter
        postFile += `\r\n--${boundary}\r\n`;
        postFile += `Content-Disposition: form-data; name="force_ocr"\r\n\r\n`;
        postFile += forceOcr ? "true" : "false";
        // use_llm parameter
        postFile += `\r\n--${boundary}\r\n`;
        postFile += `Content-Disposition: form-data; name="use_llm"\r\n\r\n`;
        postFile += useLlm ? "true" : "false";
        // output_format parameter
        postFile += `\r\n--${boundary}\r\n`;
        postFile += `Content-Disposition: form-data; name="output_format"\r\n\r\n`;
        postFile += "markdown";
        // End boundary
        postFile += `\r\n--${boundary}--\r\n`;

        const preFileBytes = encoder.encode(preFile);
        const postFileBytes = encoder.encode(postFile);

        // Combine into a single Uint8Array
        const body = new Uint8Array(preFileBytes.length + fileData.length + postFileBytes.length);
        body.set(preFileBytes, 0);
        body.set(fileData, preFileBytes.length);
        body.set(postFileBytes, preFileBytes.length + fileData.length);

        return {
            body,
            contentType: `multipart/form-data; boundary=${boundary}`,
        };
    }

    /**
     * Check if a parent item already has a note with a title matching the parent's title.
     * Returns true if such a note exists (meaning we should skip processing).
     */
    public hasExistingNote(parentItem: Zotero.Item): boolean {
        const parentTitle = parentItem.getField("title") as string;
        if (!parentTitle) return false;

        const noteIDs = parentItem.getNotes();
        for (const noteID of noteIDs) {
            const note = Zotero.Items.get(noteID);
            if (note) {
                const noteContent = note.getNote();
                // Check if note starts with an h1 containing the parent title
                if (noteContent.includes(`<h1>${this.escapeHtml(parentTitle)}</h1>`)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Get the first PDF attachment from a parent item.
     * Returns null if no PDF is found.
     */
    public getFirstPdfAttachment(parentItem: Zotero.Item): Zotero.Item | null {
        const attachmentIDs = parentItem.getAttachments();
        for (const id of attachmentIDs) {
            const attachment = Zotero.Items.get(id) as Zotero.Item;
            if (attachment && attachment.isAttachment() && attachment.attachmentPath?.toLowerCase().endsWith(".pdf")) {
                return attachment;
            }
        }
        return null;
    }

    public async convertToMarkdown(item: Zotero.Item) {
        this.apiKey = Zotero.Prefs.get(`${config.prefsPrefix}.datalabApiKey`) as string;
        const useLocalMarker = Zotero.Prefs.get(`${config.prefsPrefix}.datalabUseLocal`) as boolean;

        // Check API key for cloud mode only
        if (!useLocalMarker && !this.apiKey) {
            new ztoolkit.ProgressWindow("DataLab OCR").createLine({
                text: "Error: DataLab API Key is missing. Please set it in preferences.",
                icon: "warning",
                progress: 100
            }).show();
            return;
        }

        // Check if item is a PDF attachment
        const isPdfAttachment = (() => {
            if (!item.isAttachment()) return false;
            const contentType = item.attachmentContentType;
            if (contentType === "application/pdf") return true;
            const rawPath = item.attachmentPath || "";
            const cleanPath = rawPath.replace(/^storage:/, "").toLowerCase();
            return cleanPath.endsWith(".pdf");
        })();

        if (!isPdfAttachment) {
            new ztoolkit.ProgressWindow("DataLab OCR").createLine({
                text: "Error: Selected item is not a PDF attachment.",
                icon: "warning",
                progress: 100
            }).show();
            return;
        }

        const progressWin = new ztoolkit.ProgressWindow("DataLab OCR");
        const progressLine = progressWin.createLine({
            text: "Starting conversion...",
            progress: 10,
        });
        progressWin.show();

        try {
            ztoolkit.log("DataLab: Starting path resolution...");

            // 1. Try standard getFilePathAsync
            let filePath: string | false = false;
            try {
                filePath = await item.getFilePathAsync();
                ztoolkit.log(`DataLab: getFilePathAsync returned: ${filePath}`);
            } catch (err) {
                ztoolkit.log(`DataLab: getFilePathAsync failed: ${(err as Error).message}`);
            }

            // 2. Manual resolution if needed
            if (!filePath || (typeof filePath === 'string' && filePath.startsWith("storage:"))) {
                ztoolkit.log("DataLab: Attempting manual path resolution...");
                // @ts-ignore
                const dataDirPath = Zotero.DataDirectory.dir;
                ztoolkit.log(`DataLab: Zotero.DataDirectory.dir: ${dataDirPath}`);

                if (dataDirPath) {
                    const itemKey = item.key;
                    const rawPath = item.attachmentPath || "";
                    const fileName = rawPath.replace(/^storage:/, "");
                    ztoolkit.log(`DataLab: Manual parts - Key: ${itemKey}, FileName: ${fileName}`);

                    if (fileName) {
                        // @ts-ignore
                        filePath = PathUtils.join(dataDirPath, "storage", itemKey, fileName);
                        ztoolkit.log(`DataLab: Manually constructed path: ${filePath}`);
                    }
                } else {
                    ztoolkit.log("DataLab: Error - Zotero.DataDirectory.dir is undefined!");
                }
            }

            // 3. Final Verification
            if (!filePath || (typeof filePath === 'string' && filePath.startsWith("storage:"))) {
                throw new Error(`Could not resolve absolute path. Got: ${filePath}`);
            }

            ztoolkit.log("DataLab: Final resolved filePath", filePath);

            if (useLocalMarker) {
                // --- Local Marker Server Mode ---
                // Uses the simple API: filepath, page_range, force_ocr, paginate_output, output_format

                let localApiUrl = Zotero.Prefs.get(`${config.prefsPrefix}.datalabUrl`) as string || "http://localhost:8001";
                // Normalize URL: remove trailing slash
                localApiUrl = localApiUrl.replace(/\/$/, "");

                const localForceOcr = Zotero.Prefs.get(`${config.prefsPrefix}.localForceOcr`) as boolean ?? true;

                progressLine.changeLine({
                    text: "Sending request to Local Marker...",
                    progress: 30
                });

                ztoolkit.log(`DataLab: Posting to ${localApiUrl}/marker with filepath: ${filePath}`);

                // Simple JSON body matching the local marker API
                const jsonBody = {
                    filepath: filePath,
                    force_ocr: localForceOcr,
                    paginate_output: false,
                    output_format: "markdown"
                };

                ztoolkit.log(`DataLab: Sending JSON body: ${JSON.stringify(jsonBody)}`);

                const response = await Zotero.HTTP.request("POST", `${localApiUrl}/marker`, {
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(jsonBody),
                    responseType: "json",
                    timeout: 600000, // 10 minutes timeout for long OCR jobs
                });

                if (response.status !== 200 && response.status !== 201) {
                    throw new Error(`Local server returned status ${response.status}`);
                }

                // @ts-ignore
                const result = response.response;
                ztoolkit.log(`DataLab: Local response keys: ${Object.keys(result).join(", ")}`);
                ztoolkit.log("DataLab: Full Local response", JSON.stringify(result));

                // Extract markdown from response - try common field names
                const markdown = result.markdown || result.text || result.content || result.output || (typeof result === 'string' ? result : "");

                if (!markdown) {
                    throw new Error("Could not extract markdown from local server response. Check debug logs for response structure.");
                }

                progressLine.changeLine({
                    text: "Saving extracted note...",
                    progress: 90
                });

                await this.saveNote(item, markdown);

                progressLine.changeLine({
                    text: "Done!",
                    progress: 100
                });
                setTimeout(() => progressWin.close(), 3000);

            } else {
                // --- Cloud DataLab API Mode ---
                // Read cloud-specific settings
                const cloudForceOcr = Zotero.Prefs.get(`${config.prefsPrefix}.cloudForceOcr`) as boolean ?? false;
                const cloudUseLlm = Zotero.Prefs.get(`${config.prefsPrefix}.cloudUseLlm`) as boolean ?? false;

                // Read the file using IOUtils
                // @ts-ignore
                const fileData: Uint8Array = await IOUtils.read(filePath);
                ztoolkit.log(`DataLab: Read ${fileData.length} bytes from file`);

                progressLine.changeLine({
                    text: "Uploading PDF to DataLab Cloud...",
                    progress: 30
                });

                // Build multipart body with cloud settings
                const { body, contentType } = this.buildMultipartBody(fileData, "document.pdf", cloudForceOcr, cloudUseLlm);

                // Use Zotero.HTTP.request for the upload
                const uploadResponse = await Zotero.HTTP.request("POST", `${this.apiUrl}/marker`, {
                    headers: {
                        "X-Api-Key": this.apiKey,
                        "Content-Type": contentType,
                    },
                    body: body,
                    responseType: "json",
                });

                const uploadResult = uploadResponse.response as unknown as DatalabResponse;
                ztoolkit.log("DataLab: Upload response", JSON.stringify(uploadResult));

                if (!uploadResult.success || !uploadResult.request_check_url) {
                    throw new Error(uploadResult.error || "Upload failed");
                }

                progressLine.changeLine({
                    text: "Processing... (This may take a while)",
                    progress: 50
                });

                const result = await this.pollForResults(uploadResult.request_check_url, progressLine);

                if (!result.success || result.status !== "complete") {
                    throw new Error(result.error || "Conversion failed");
                }

                progressLine.changeLine({
                    text: "Saving extracted note...",
                    progress: 90
                });

                await this.saveNote(item, result.markdown || "");

                progressLine.changeLine({
                    text: "Done!",
                    progress: 100
                });
                setTimeout(() => progressWin.close(), 3000);
            }

        } catch (e) {
            ztoolkit.log(e);
            progressLine.changeLine({
                text: `Error: ${(e as Error).message}`,
                icon: "warning",
                progress: 100
            });
        }
    }

    private async pollForResults(checkUrl: string, progressLine: any): Promise<DatalabPolledResult> {
        const maxPolls = 300; // 300 * 2s = 600s = 10 mins
        let attempts = 0;
        let currentProgress = 50;

        while (attempts < maxPolls) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            attempts++;

            try {
                const response = await Zotero.HTTP.request("GET", checkUrl, {
                    headers: this.getAuthHeaders(),
                    responseType: "json",
                });
                const data = response.response as unknown as DatalabPolledResult;

                if (data.status === "complete") {
                    return data;
                } else if (data.status === "failed") {
                    return data;
                }

                if (attempts % 5 === 0 && currentProgress < 85) {
                    currentProgress += 1;
                    progressLine.changeLine({
                        progress: currentProgress
                    });
                }

            } catch (e) {
                ztoolkit.log("Polling error", e);
            }
        }
        throw new Error("Polling timed out");
    }

    private async saveNote(attachmentItem: Zotero.Item, markdown: string) {
        const note = new Zotero.Item("note");

        // Determine the parent and get its title
        let parentItem: Zotero.Item | null = null;
        if (attachmentItem.parentID) {
            parentItem = Zotero.Items.get(attachmentItem.parentID) as Zotero.Item;
            note.parentID = attachmentItem.parentID;
            ztoolkit.log(`DataLab: Attaching note to parent item ${attachmentItem.parentID}`);
        } else {
            note.parentID = attachmentItem.id;
            ztoolkit.log(`DataLab: PDF is top-level, attaching note to PDF ${attachmentItem.id}`);
        }

        // Get title from parent item, or fallback to attachment title/filename
        const title = parentItem?.getField("title") || attachmentItem.getField("title") || "Extracted Text";

        note.libraryID = attachmentItem.libraryID;
        note.setNote(`<h1>${this.escapeHtml(title as string)}</h1><pre style="white-space: pre-wrap;">${this.escapeHtml(markdown)}</pre>`);
        await note.saveTx();
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
