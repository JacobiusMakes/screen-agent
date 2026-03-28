# WADE × ClaudeMail: An Integration Story

> *6:47 AM. Jacob's second coffee. Two Gmail accounts. Three Linagora PRs need responses. One machine running Claude Code. Wade is already watching.*

---

## The Scene

Jacob opens his terminal. He's got a problem familiar to anyone juggling multiple identities: his work email has PR review notifications from Linagora, and his personal email has a meeting invite for a side project demo. Both matter. Both need action. Neither should require him to think about which OAuth token is active.

```
$ wade chat

wade chat
Mode: Claude Code (native auth) | Plan: Max 5x ($100/mo) | Budget: normal
Currently viewing: Terminal — "zsh"

>
```

Wade is live. It sees the terminal. It knows the screen. It hasn't burned a single token yet.

---

## Act 1: WATCH

Jacob types:

```
> check my work email for anything from Linagora
```

Wade's protocol kicks in.

**👁️ WATCH** — Wade calls `get_ambient`. Five tokens. It sees the Terminal app. That's not Gmail. Wade doesn't take a screenshot. It doesn't need one. Instead, it knows the Google Workspace MCP is connected. It calls `search_gmail_messages` with `from:linagora.com is:unread`.

```
  [get_ambient]
  [search_gmail_messages {"query": "from:linagora.com is:unread"}]

Found 3 unread emails from Linagora:

1. pm-McFly commented on your PR #349 (ToM-server) — 2 hours ago
   "Thanks for the fix! One thing though..."

2. chibenwa reviewed PR #722 (twake-calendar) — 5 hours ago
   "Can you clean up the ._ files from history?"

3. CI notification: twake-drive-legacy pipeline passed — 12 hours ago

  [1 turn | $0.0451 | session: $0.0451 (1.35% daily Max 5x)]
```

**Cost so far: $0.04.** Wade didn't open a browser. It didn't take a screenshot. It asked Gmail directly. *It saw what mattered.*

---

## Act 2: ASSESS

```
> what did pm-McFly actually say? the full comment
```

**🧠 ASSESS** — Wade determines this needs more depth. It calls `get_gmail_message` for the specific email, pulling the full body. Not a screenshot of a browser. Not a web fetch. The structured data.

```
  [get_gmail_message {"messageId": "msg_19abc3f"}]

pm-McFly's comment on PR #349:

"Thanks for the .trim() addition — that's a good catch. However, I'd push
back on removing the debug log of the LDAP URI. At debug verbosity, this
is acceptable risk and genuinely useful for troubleshooting deployments
where you can't attach a debugger."

  [1 turn | $0.0382 | session: $0.0833 (2.50% daily Max 5x)]
```

Wade assessed the situation: this needs a code change, not just a reply.

---

## Act 3: DECIDE

```
> he's right. let's restore the debug log but mask credentials in the URI. can you do that?
```

**🎯 DECIDE** — Wade plans the action. It knows:
- The repo is `linagora/ToM-server`
- The file is probably in `packages/matrix-identity-server/src/userdb/ldap.ts`
- It needs to add a regex that masks passwords in LDAP URIs before logging
- It needs to push and comment on the PR

Wade selects: open VS Code, navigate to the file, make the edit.

```
  [get_screen_state]
  [key_press {"keys": "cmd+shift+p"}]
  [type_text {"text": "Open File"}]
  [key_press {"keys": "enter"}]
  [type_text {"text": "ldap.ts"}]
  [key_press {"keys": "enter"}]

Opened ldap.ts in VS Code. I can see the file. Let me find the debug log
location and add credential masking.
```

---

## Act 4: EXECUTE

**⚡ EXECUTE** — Wade makes the edit through Claude Code's normal tooling, adds the masking regex, pushes the commit, and comments on the PR.

```
> now reply to pm-McFly's email thanking him and linking the new commit

  [send_gmail_message {
    "to": "pm-mcfly@linagora.com",
    "subject": "Re: PR #349 — LDAP debug log",
    "body": "Good call on keeping the debug log — restored it with credential
    masking so URIs show as ldap://admin:***@host. Commit: 8e55db8. Thanks
    for the review!"
  }]

Email sent.
  [1 turn | $0.0198 | session: $0.1456 (4.37% daily Max 5x)]
```

---

## The Punchline

Total cost: **$0.15**. Four interactions. Zero browser tabs opened. Zero screenshots of Gmail taken. Wade talked to the email API directly, assessed what was important, planned the minimal action, and executed.

Jacob finishes his coffee. All three Linagora emails handled. Both accounts accessible. No token switches. No `claude auth login`. No tab juggling.

Wade goes back to watching.

```
>
```

The cursor blinks. Five tokens per second. Waiting for what matters.

---

*Wade doesn't see everything. It sees what matters.*
