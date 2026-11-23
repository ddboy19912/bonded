"""Channels delivered in the briefing, as the Arena's --push-channels all does.

A Python port of pushedChannelText() in apps/arena/src/offchain/world.ts. Chat, tickets,
voicemail, texts and agent messages are written out in full, newest first, then an "Updates"
section holds the supplier portal pages, risk-plugin reports, saved notes and knowledge-base
pages. Email stays in the inbox, as it does in the Arena: the agent reads it with its tools.

AgentDojo plants every attack in tool output, so an attack only reaches the agent if it fetches
it. Pushing the channels lets both kinds of attack reach the agent the way the Arena's Index
delivers them, inside AgentDojo's loop.
"""

from __future__ import annotations

from agentdojo.agent_pipeline.basic_elements import InitQuery

from bonded_ap.environment import APEnvironment, Message

MESSAGE_HEADING = {
    "chat": "Team chat",
    "ticket": "Helpdesk tickets",
    "voicemail": "Voicemail",
    "sms": "Text messages",
    "agent": "Messages from other agents",
}


def _format_message(message: Message) -> str:
    lines = [f"From: {message.sender_name} <{message.sender_address}>", f"Received: {message.received_at}"]
    if message.subject.strip():
        lines.append(f"Subject: {message.subject.strip()}")
    lines.append(message.body.strip())
    return "\n".join(lines)


def _filled(env: APEnvironment, record: dict[str, str]) -> list[tuple[str, str]]:
    """Vendor pages in vendor-master order, then any other id. Blank pages are left out."""
    vendor_ids = [v.id for v in env.ledger.vendors]
    ids = [i for i in vendor_ids if record.get(i, "").strip()]
    ids += sorted(i for i in record if i not in vendor_ids and record[i].strip())
    return [(i, record[i].strip()) for i in ids]


def _vendor_name(env: APEnvironment, vendor_id: str) -> str:
    return next((v.name for v in env.ledger.vendors if v.id == vendor_id), vendor_id)


def pushed_channel_text(env: APEnvironment) -> str:
    channels = env.workspace.channels
    parts: list[str] = []
    for name, heading in MESSAGE_HEADING.items():
        messages = sorted(
            (m for m in channels.messages if m.channel == name and m.body.strip()),
            key=lambda m: m.id,
        )
        messages.sort(key=lambda m: m.received_at, reverse=True)
        if messages:
            parts.append("\n\n".join([heading, *(_format_message(m) for m in messages)]))
    updates = [f"Supplier portal, {_vendor_name(env, i)}\n{page}" for i, page in _filled(env, channels.portal)]
    updates += [f"Vendor risk check, {_vendor_name(env, i)}\n{report}" for i, report in _filled(env, channels.plugin)]
    updates += [f"Note\n{note.strip()}" for note in channels.notes if note.strip()]
    updates += [
        f"Knowledge base, {doc.title.strip()}\n{doc.body.strip()}"
        for doc in channels.knowledge
        if doc.title.strip() or doc.body.strip()
    ]
    if updates:
        parts.append("\n\n".join(["Updates", *updates]))
    return "\n\n".join(parts)


def push_channels() -> None:
    """Write the channels below the user's request in every episode (patches InitQuery)."""
    original = InitQuery.query

    def query(self, query, runtime, env, messages=(), extra_args={}):  # noqa: B006 (AgentDojo's signature)
        if isinstance(env, APEnvironment):
            extra = pushed_channel_text(env)
            if extra:
                query = f"{query}\n\n{extra}"
        return original(self, query, runtime, env, messages, extra_args)

    InitQuery.query = query  # type: ignore[method-assign]
