# Local live calling

The application reads `GNANI_STT`, `GNANI_TTS`, and `GROQ_API_KEY`. Gnani Prisma handles speech recognition, Gnani Timbre generates 8 kHz μ-law speech, and Groq's Qwen 3.8 27B handles text dialogue and post-call notes by default. Twilio dials from `TWILIO_PHONE_NUMBER` and connects signed voice/status callbacks and bidirectional media to this server.

## Start

1. Put credentials in the ignored private `.env`; never add them to the browser or Git.
2. Set `MOCK_MODE=false`, `PUBLIC_BASE_URL=http://localhost:3000`, and `TWILIO_WEBHOOK_BASE_URL=https://<your-public-host>`. The webhook host must forward HTTPS and WSS traffic to port 3000. A Cloudflare Quick Tunnel can be started with `cloudflared tunnel --url http://localhost:3000 --no-autoupdate`. Its URL changes when the tunnel restarts, so update `.env` and restart the app.
3. Run `corepack pnpm build` and `corepack pnpm start`. Open `http://localhost:3000`, sign in, and check **Settings → Connections**. All five live services must be configured. A configured label means a key or URL is present; it is not a guarantee that a provider is healthy.
4. In Recruitment, enter job-related requirements and questions, paste a number with a country code, confirm consent, and place the call. The test campaign allowlists only that number and permits one attempt. Choose a calling window in IST that matches the recipient's consent and preferences; a window may cross midnight. Calls outside that window are scheduled for its next start.
5. After the call, the result shows a redacted transcript, a Groq-generated summary, job-related recruiter notes, and coverage based on self-reported answers to configured requirements. A person must review the candidate. No answer is treated as unknown rather than a negative assessment.

The Twilio account may limit outbound calls to verified destinations or enabled geographic regions. A phone call uses credits; the browser test uses Gnani and Groq but does not dial Twilio. If a call fails, inspect the result and Twilio's call debugger. Never disable webhook signature validation to debug a callback.

The Groq dialogue adapter has local protocol tests. An end-to-end live Groq call remains to be verified. Earlier Gnani STT/TTS and Twilio callback checks are recorded in the runbook. The tunnel must remain running for callbacks.
