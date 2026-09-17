# GapGPT API

Run `npm start` from the project directory and sign in to GapGPT using the
initial browser tab if needed. `.env.example` lists optional settings; existing
`.env` files do not need new entries because each setting has a default.

Send `Authorization: Bearer <your-token>` on `/v1/` requests. Any non-empty
token of up to 512 characters without whitespace is accepted. `AUTH_TOKEN`
in the server environment is ignored. Tokens identify clients; they are not
verified credentials. Reusing a token gives access to that token's chats.
All tabs use the same signed-in GapGPT account and its shared quota.

## Conversations

The conversation key is the combination of the Bearer token and
`conversation_id`. IDs are case-sensitive, contain letters, digits, hyphens
or underscores, and have a maximum length of 128 characters.

- Omit `conversation_id` to continue the token's `default` conversation.
- Supply a different ID to start or continue another chat for the same token.
- Each conversation has its own FIFO queue. Different conversations can run
  concurrently within the configured limits.
- Only the last user message in `messages` is sent. History is held by the
  remote chat; resubmitting previous messages does not rebuild it.
- IDs are returned in `conversation_id` and the `X-Conversation-Id` header,
  including in streaming responses.

Example request to `POST /v1/chat/completions`:

```json
{
  "model": "gapgpt",
  "conversation_id": "work",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

Send the next message with the same token and `conversation_id` to continue.
Use a different ID for a new chat, or call `POST /v1/conversations` with `{}`
to allocate a random ID. Its response is `{ "id": "...", "created_at": "..." }`.
An optional `conversation_id` in that endpoint reserves your own ID;
repeating it returns the existing conversation and does not reset history.
Creating metadata does not open a browser tab until the first message.

`GET /v1/conversations` lists only the calling token's conversations, including
whether each has a saved URL (`resumable`). `GET /v1/models` lists models.
`GET /health` needs no token and reports browser connectivity, open chat tabs,
active/queued requests, tab/concurrency limits and stored conversation count.
The initial login tab is excluded from chat tab counts and limits.

## Persistence and recovery

`conversations.json` stores the hash of each token, conversation IDs and
observed remote chat URLs. Writes replace the file atomically. Tokens are not
stored in plaintext. Browser login state is saved separately in
`browser-state.json` every 30 seconds and on graceful shutdown. Both files
are excluded from Git. Run a single server process per project/state file.

After a restart, a manually closed tab, or browser disconnection, the next
request reopens the saved chat URL. Browser launches are shared by concurrent
requests. Failed setup may retry once **before sending**; sent messages are
never automatically repeated. If login expires, sign in using the initial
tab and retry only requests known not to have been sent.

Idle tabs close after 10 minutes by default. At the tab limit, the oldest
available idle tab is closed to make room. Active tabs are preserved. Closing
a tab does not delete its remote chat or local mapping.

Recovery depends on the remote chat still existing and its URL having been
observed and saved. If a first send is interrupted before that happens, the
server reports `history_unavailable` instead of silently creating a different
chat. Keep an unsaved live tab open, inspect the remote chat, or explicitly
create a new conversation. Conversations from the previous in-memory-only
version cannot be automatically mapped back to their original tokens.

## Safe retries

Add a unique `Idempotency-Key` header to each logical message, and reuse that
key with the same content, model, token and conversation when retrying.
Keys accept 1–128 printable ASCII characters without spaces.

- Simultaneous identical requests share one send.
- Completed requests replay their saved answer, including after a restart.
  A streaming replay emits the saved answer as one content chunk.
- A reused key with different content/model returns `idempotency_conflict`.
- If delivery was interrupted after clicking Send, repeating the key returns
  `request_outcome_unknown`; inspect the chat before choosing a new key.
- Without a key, separate requests are separate messages even if text matches.

The last 100 keys per conversation are retained by default. The oldest
completed keys are evicted when needed; pending/uncertain keys are not evicted.
Do not reuse keys after they leave this retention window. Answer text for
retained successful keys is stored locally; message text is fingerprinted.

## Limits

All settings below are positive integers in `.env`.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `MAX_CHAT_TABS` | 6 | Open chat tabs, plus the separate login tab |
| `MAX_CONCURRENT_REQUESTS` | 3 | Active sends; capped by the chat tab limit |
| `MAX_PENDING_REQUESTS` | 100 | Total accepted active and queued requests |
| `MAX_PENDING_PER_TOKEN` | 20 | Active and queued requests per token |
| `MAX_PENDING_PER_CONVERSATION` | 10 | Active and queued requests per conversation |
| `MAX_STORED_CONVERSATIONS` | 1000 | Total stored mappings |
| `MAX_CONVERSATIONS_PER_TOKEN` | 100 | Stored mappings per token |
| `TAB_IDLE_TIMEOUT_MS` | 600000 | Idle lifetime; cleanup checks at most every 30 seconds |
| `MAX_BODY_BYTES` | 1048576 | Maximum JSON request body size |
| `MAX_MESSAGE_CHARS` | 64000 | Maximum last-user-message length (JavaScript UTF-16 units) |
| `REQUESTS_PER_MINUTE_PER_TOKEN` | 60 | `/v1/` requests per token per fixed minute window |
| `REQUESTS_PER_MINUTE_GLOBAL` | 300 | Total `/v1/` requests per fixed minute window |
| `GENERATION_TIMEOUT` | 300000 | Generation timeout in milliseconds |
| `IDEMPOTENCY_HISTORY_SIZE` | 100 | Retained request keys per conversation |

Queue/rate/capacity limits return HTTP 429; size limits return 413.
Rate limiting also covers metadata calls and replay requests. Changing tokens
does not bypass the global rate, queue, concurrency or tab limits.

## Errors

Errors use this shape:

```json
{
  "error": {
    "code": "browser_unavailable",
    "message": "Browser connection or conversation tab was closed.",
    "retryable": false,
    "delivery": "unknown"
  }
}
```

`delivery` is `not_sent`, `rejected` or `unknown`. An unknown outcome must not
be blindly resubmitted. Typical codes are `login_required`,
`composer_unavailable`, `upstream_quota`, `upstream_timeout`,
`browser_unavailable`, `history_unavailable`, `storage_unavailable`,
`capacity_exceeded`, `rate_limit_exceeded` and `request_outcome_unknown`.
HTTP 429 includes `Retry-After`; account quota errors additionally require
the shared account's limit to be resolved.

For streaming, failures before the first content chunk use normal HTTP errors.
Once streaming has started, an error is emitted as an SSE `data:` event and
the stream ends without `[DONE]` or a successful finish marker. A client
disconnect does not cancel an already accepted message; reuse its request key
to retrieve a retained completed result.

## Validation

Run `npm test`. Tests cover HTTP and SSE behavior, persistence across manager
restarts, token/chat isolation, idle eviction, queue/rate/body limits, browser
recovery, uncertain delivery, idempotency and split UTF-8 request bodies.
Browser tests use local doubles and the real capture reducer; they do not send
messages to the live GapGPT site or verify its current UI/URL conventions.
