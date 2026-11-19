# Employee chat completions

`POST /api/v1/chat/completions` accepts a Shiba API key with `api:write`
from the self-hosted deployment. It serves text-only Chat mode: the employee's
profile supplies the instructions, your request supplies the conversation, and
the deployment's Workers AI chat model replies. Nothing is added to dashboard
threads. This endpoint can't use tools, access repositories, start sandboxes,
or request or grant approvals. Use the dashboard's approval-gated Work mode
for actions. Team credentials and workspace overrides are not supported.

## Try it locally

Start the local Worker with its D1 migrations, KV and Workers AI binding. In the
local dashboard, create an active employee and issue an API key scoped to
`api:write`. Put the Shiba key in `SHIBA_API_KEY` in your shell without
printing it. Replace `scout` with your employee's slug. Local Wrangler needs
access to Workers AI for a real completion.

```sh
curl --fail-with-body http://localhost:8788/api/v1/chat/completions \
  -H "Authorization: Bearer ${SHIBA_API_KEY:?Set a Shiba API key}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"shiba/scout","messages":[{"role":"user","content":"Suggest three names for a release."}]}'
```

With the Python OpenAI SDK installed (`python -m pip install openai`):

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8788/api/v1", api_key=os.environ["SHIBA_API_KEY"])
reply = client.chat.completions.create(
    model="shiba/scout",
    messages=[{"role": "user", "content": "Suggest three names for a release."}],
)
print(reply.choices[0].message.content)
```

Send 1–20 messages with roles `user` or `assistant`, ending in `user`.
Each message can have up to 4,000 characters of plain text. Omit `stream`
or set it to `false`. System messages, tool calls, attachments, and generation
options aren't supported. The existing per-key rate limit applies across API
routes. On Access-protected installs, allow only this exact path to reach the
Worker bearer gate; the Alchemy stack already declares that exception.
