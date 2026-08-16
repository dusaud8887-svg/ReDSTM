import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

const retrySoon = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

async function requestExport(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.success === false || !envelope.result) {
    throw new Error(`D1 export request failed (${response.status})`);
  }
  return envelope.result;
}

function exportFailure(result) {
  const detail = typeof result.error === "string" ? `: ${result.error}` : "";
  return `d1_export_failed${detail}`;
}

function startedBookmark(result) {
  if (result.status === "error") throw new Error(exportFailure(result));
  if (!result.at_bookmark) throw new Error("D1 export bookmark is missing");
  return result.at_bookmark;
}

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(_event, step) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.ACCOUNT_ID}/d1/database/${this.env.DATABASE_ID}/export`;
    let bookmark = await step.do("Start D1 export", retrySoon, async () => {
      const result = await requestExport(url, this.env.D1_REST_API_TOKEN, {
        output_format: "polling",
      });
      return startedBookmark(result);
    });

    for (let restart = 0; restart < 3; restart += 1) {
      try {
        return await step.do(
          `Store D1 export in R2 ${restart + 1}`,
          {
            retries: { limit: 30, delay: "10 seconds", backoff: "constant" },
            timeout: "1 minute",
          },
          async () => {
            const result = await requestExport(url, this.env.D1_REST_API_TOKEN, {
              output_format: "polling",
              current_bookmark: bookmark,
            });
            if (result.status === "error") {
              throw new NonRetryableError(exportFailure(result));
            }
            const completed = result.result ?? result;
            if (!completed.signed_url || !completed.filename) {
              throw new Error("D1 export is not ready");
            }
            const response = await fetch(completed.signed_url);
            if (!response.ok || !response.body) {
              throw new Error(`D1 export download failed (${response.status})`);
            }
            const filename = completed.filename.split("/").at(-1);
            if (!filename || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
              throw new Error("D1 export filename is invalid");
            }
            const key = `redstm-control/${filename}`;
            const object = await this.env.BACKUP_BUCKET.put(key, response.body, {
              httpMetadata: { contentType: "application/sql" },
              customMetadata: { bookmark },
            });
            const saved = { key, size: object.size, etag: object.etag };
            console.log(JSON.stringify({ event: "d1_backup_saved", ...saved }));
            return saved;
          },
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("d1_export_failed") ||
          restart === 2
        ) {
          throw error;
        }
        bookmark = await step.do(`Restart D1 export ${restart + 1}`, retrySoon, async () => {
          const result = await requestExport(url, this.env.D1_REST_API_TOKEN, {
            output_format: "polling",
          });
          return startedBookmark(result);
        });
      }
    }
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller, env) {
    await env.D1_BACKUP_WORKFLOW.create();
  },
};
