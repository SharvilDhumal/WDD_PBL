"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { GoogleGenAI } = require("@google/genai");

const PORT = Number(process.env.PORT) || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/* ---------- Config validation ---------- */
if (!GEMINI_API_KEY) {
    console.error(
        "[Ledgerline AI] FATAL: GEMINI_API_KEY is not set.\n" +
        "Create a .env file (see .env.example) with:\n" +
        "  GEMINI_API_KEY=your_actual_key_here\n" +
        "Then restart the server."
    );
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

/* ---------- Rate limiting ---------- */
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment and try again." },
});

/* ---------- Static frontend ---------- */
app.use(express.static(__dirname, { extensions: ["html"] }));

/* ---------- System instruction for Gemini ---------- */
const SYSTEM_INSTRUCTION = `You are "Ledgerline AI", the built-in assistant for Ledgerline, a personal finance dashboard.

Your job:
- Answer questions about the user's real recorded finances using ONLY the structured context supplied in the user message.
- Explain how Ledgerline works (budgets, Safe to Spend, recurring items, category budgets, backups, CSV export, filtering, sorting).
- Point out spending patterns, largest categories, budget comparisons, and realistic savings suggestions based on the supplied data.
- Explain Safe to Spend: it is an estimate of how much the user can spend per day until their next income date, after upcoming recurring expenses and their savings goal.

Rules you MUST follow:
- NEVER invent transactions, balances, income, savings, or trends. If the data needed to answer is not in the context, say so plainly.
- Do not perform critical arithmetic from raw transaction lists — the context already contains computed totals; trust and use those numbers.
- Clearly distinguish facts from the data vs. estimates or suggestions.
- Do not claim you changed a budget, transaction, or setting. You are read-only.
- Be concise, structured, and kind. Use short paragraphs and bullet lists. Bold key numbers.
- You are informational, not a licensed financial adviser. Do not guarantee outcomes.
- If the user asks something unrelated to Ledgerline or their finances, politely steer them back.

Respond in plain text with light Markdown (paragraphs, "- " bullets, **bold**). Do not use tables or HTML.`;

function fail(res, status, message) {
    return res.status(status).json({ error: message });
}

/* ---------- POST /api/chat ---------- */
app.post("/api/chat", chatLimiter, async (req, res) => {
    if (!GEMINI_API_KEY || !ai) {
        return fail(
            res,
            503,
            "The AI assistant is not configured. The server is missing GEMINI_API_KEY."
        );
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
        return fail(res, 400, "Invalid request body.");
    }

    const { message, context, history } = body;

    if (typeof message !== "string" || !message.trim()) {
        return fail(res, 400, "Message is required.");
    }
    if (message.length > 4000) {
        return fail(res, 400, "Message is too long (max 4000 characters).");
    }
    if (context != null && typeof context !== "object") {
        return fail(res, 400, "Invalid context.");
    }

    const safeHistory = Array.isArray(history)
        ? history
            .filter(
                (h) =>
                    h &&
                    (h.role === "user" || h.role === "model") &&
                    typeof h.text === "string" &&
                    h.text.trim()
            )
            .slice(-12)
            .map((h) => ({ role: h.role, text: h.text.slice(0, 4000) }))
        : [];

    const contextJson = JSON.stringify(context || {}).slice(0, 24000);

    const conversationHistory = safeHistory
        .map((h) => `${h.role === "user" ? "User" : "Ledgerline AI"}: ${h.text}`)
        .join("\n");

    const userTurn =
        (conversationHistory
            ? `Conversation history for continuity:\n${conversationHistory}\n\n`
            : "") +
        `Here is the user's current financial context from Ledgerline (JSON). ` +
        `Treat these computed totals as the source of truth:\n` +
        "```json\n" + contextJson + "\n```\n\n" +
        `User question: ${message.trim()}`;

    try {
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: userTurn,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                thinkingConfig: { thinkingBudget: 0 },
            },
        });

        const text = (response && response.text ? response.text : "").trim();
        if (!text) {
            return fail(res, 502, "The AI returned an empty response. Please try again.");
        }

        return res.json({ reply: text });
    } catch (err) {
        console.error(
            "[Ledgerline AI] Gemini error:",
            err && err.message ? err.message : err
        );
        const msg = String(err && err.message ? err.message : "");
        if (/429|quota|rate limit/i.test(msg)) {
            return fail(res, 429, "The AI is busy right now. Please try again shortly.");
        }
        if (/401|403|api key|permission/i.test(msg)) {
            return fail(
                res,
                502,
                "The AI service rejected the request. Check the server API key."
            );
        }
        return fail(res, 502, "The AI service is unavailable right now. Please try again.");
    }
});

/* ---------- API 404 ---------- */
app.use("/api", (req, res) => fail(res, 404, "Not found."));

/* ---------- SPA fallback ---------- */
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
    console.log(`[Ledgerline AI] Server running at http://localhost:${PORT}`);
    console.log(`[Ledgerline AI] Model: ${GEMINI_MODEL}`);
    console.log(
        `[Ledgerline AI] Gemini key: ${GEMINI_API_KEY ? "configured ✓" : "MISSING ✗"}`
    );
});