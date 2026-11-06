"use strict";

/**
 * LLM access with a provider chain. Every module works with `provider: none` —
 * cards fall back to deterministic text — so an outage or an empty credit
 * balance degrades output, it never stops a post.
 *
 * Providers:
 *   anthropic          Claude via the official SDK (default model claude-opus-5-5)
 *   openai-compatible  any /chat/completions endpoint (OpenRouter, Azure OpenAI,
 *                      a local server…) — set baseUrl + model
 *   none               no LLM; deterministic fallbacks only
 *
 * workspace.yaml:
 *   llm:
 *     provider: anthropic
 *     model: claude-opus-5-5
 *     apiKey: ANTHROPIC_API_KEY        # name of the secret in .env
 *     effort: medium
 *     fallbacks:                       # tried in order if the primary fails
 *       - { provider: openai-compatible, baseUrl: https://openrouter.ai/api/v1, model: ..., apiKey: OPENROUTER_API_KEY }
 */

class LlmError extends Error {}

function anthropicProvider(cfg, secret) {
  let client = null;
  return {
    name: `anthropic:${cfg.model}`,
    async complete({ system, prompt, maxTokens }) {
      if (!client) {
        const mod = require("@anthropic-ai/sdk");
        const Anthropic = mod.default || mod;
        const apiKey = secret(cfg.apiKey || "ANTHROPIC_API_KEY");
        if (!apiKey) throw new LlmError(`secret ${cfg.apiKey || "ANTHROPIC_API_KEY"} is not set`);
        client = new Anthropic({ apiKey, timeout: (cfg.timeoutSeconds || 300) * 1000, maxRetries: 2 });
      }
      const params = {
        model: cfg.model,
        max_tokens: maxTokens || cfg.maxTokens || 16000,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: cfg.effort || "medium" },
      };
      // Server-side fallback: if a safety classifier declines, Anthropic retries on a
      // suitable model instead of returning a refusal. On by default; serverFallback: false turns it off.
      const res = cfg.serverFallback === false
        ? await client.messages.create(params)
        : await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
      if (res.stop_reason === "refusal") throw new LlmError(`model declined (${(res.stop_details && res.stop_details.category) || "refusal"})`);
      const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text) throw new LlmError(`empty response (stop_reason ${res.stop_reason})`);
      return text;
    },
  };
}

function openAiCompatibleProvider(cfg, secret) {
  return {
    name: `openai-compatible:${cfg.model}`,
    async complete({ system, prompt, maxTokens }) {
      const key = secret(cfg.apiKey || "LLM_API_KEY");
      if (!key) throw new LlmError(`secret ${cfg.apiKey || "LLM_API_KEY"} is not set`);
      const res = await fetch(`${String(cfg.baseUrl || "").replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model, max_tokens: maxTokens || cfg.maxTokens || 4000, temperature: 0,
          messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout((cfg.timeoutSeconds || 180) * 1000),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 402) throw new LlmError("out of credit (402) — top up the provider account");
      if (!res.ok) throw new LlmError(`${res.status}: ${(j.error && j.error.message) || res.statusText}`);
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
      if (!text) throw new LlmError("empty response");
      return text;
    },
  };
}

function build(cfg, secret) {
  if (!cfg || cfg.provider === "none") return null;
  if (cfg.provider === "anthropic") return anthropicProvider({ model: "claude-opus-5-5", ...cfg }, secret);
  if (cfg.provider === "openai-compatible") return openAiCompatibleProvider(cfg, secret);
  throw new Error(`Unknown llm provider "${cfg.provider}" (anthropic | openai-compatible | none)`);
}

function createLlm(cfg, secret, log) {
  const chain = [build(cfg, secret), ...((cfg && cfg.fallbacks) || []).map((f) => build(f, secret))].filter(Boolean);
  return {
    enabled: chain.length > 0,
    names: chain.map((p) => p.name),
    /** Returns text, or throws LlmError when every provider failed. */
    async complete(req) {
      if (!chain.length) throw new LlmError("no LLM configured (llm.provider: none)");
      const errors = [];
      for (const p of chain) {
        try {
          return await p.complete(req);
        } catch (e) {
          errors.push(`${p.name}: ${e.message}`);
          if (log) log.warn(`llm ${p.name} failed: ${e.message}`);
        }
      }
      throw new LlmError(errors.join(" | "));
    },
  };
}

module.exports = { createLlm, LlmError };
