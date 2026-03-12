export async function sendWebhook(url: string, payload: unknown): Promise<void> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return;
  }

  try {
    await fetch(trimmed, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // Best-effort: webhook failures should not impact the agent loop.
  }
}
