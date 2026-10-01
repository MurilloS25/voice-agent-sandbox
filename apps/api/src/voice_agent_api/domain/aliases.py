"""Fictional customer aliases. A pure function of the proposal id: no free text is accepted."""

from uuid import UUID

_ADJECTIVES = (
    "Amber", "Brisk", "Calm", "Dapper", "Eager", "Frosty", "Gentle", "Hazel",
    "Ivory", "Jolly", "Keen", "Lucky", "Mellow", "Nimble", "Olive", "Plucky",
)  # fmt: skip
_ANIMALS = (
    "Heron", "Otter", "Falcon", "Badger", "Lynx", "Marten", "Newt", "Osprey",
    "Panda", "Quail", "Robin", "Stoat", "Tern", "Vole", "Wren", "Yak",
)  # fmt: skip


def alias_for(proposal_id: UUID) -> str:
    n = proposal_id.int
    return f"Demo {_ADJECTIVES[n % 16]} {_ANIMALS[(n >> 8) % 16]}"
