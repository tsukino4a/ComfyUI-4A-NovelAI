"""Minimal Comfy/Anima parenthesis-weight to NovelAI numeric-group conversion.

This plugin cannot import 4A Prompt Manager. Only unescaped ``(text:1.2)``
groups are converted. Escaped parentheses, ``[]``, ``{}``, and ``__wildcards__``
are preserved verbatim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Sequence


DEFAULT_WEIGHT = Decimal("1.1")
NUMBER_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)")


class PromptSyntaxError(ValueError):
    """Raised when parenthesis weight syntax is structurally invalid."""


@dataclass(frozen=True)
class TextNode:
    text: str


@dataclass(frozen=True)
class GroupNode:
    weight: Decimal
    children: list["Node"]


Node = TextNode | GroupNode


class Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def parse(self) -> list[Node]:
        return self._parse_until(None)

    def _parse_until(self, closer: str | None) -> list[Node]:
        nodes: list[Node] = []
        buffer: list[str] = []

        def flush() -> None:
            if buffer:
                nodes.append(TextNode("".join(buffer)))
                buffer.clear()

        while self.pos < len(self.text):
            character = self.text[self.pos]
            if character == "\\":
                buffer.append(character)
                self.pos += 1
                if self.pos < len(self.text):
                    buffer.append(self.text[self.pos])
                    self.pos += 1
                continue
            if character == ")":
                if closer == ")":
                    flush()
                    self.pos += 1
                    return nodes
                raise PromptSyntaxError(
                    f"unexpected closing ')' at position {self.pos}"
                )
            if character == "(":
                flush()
                nodes.append(self._parse_group())
                continue
            if character in "[{":
                flush()
                nodes.append(TextNode(self._consume_opaque(character)))
                continue
            if self.text.startswith("__", self.pos):
                wildcard = self._consume_wildcard()
                if wildcard is not None:
                    flush()
                    nodes.append(TextNode(wildcard))
                    continue
            buffer.append(character)
            self.pos += 1

        flush()
        if closer is not None:
            raise PromptSyntaxError("missing closing ')' for group")
        return nodes

    def _parse_group(self) -> GroupNode:
        start = self.pos
        self.pos += 1
        children = self._parse_until(")")
        weight, content = _extract_weight(children)
        if not _has_content(content):
            raise PromptSyntaxError(
                f"empty weighted group starting at position {start}"
            )
        return GroupNode(weight=weight, children=content)

    def _consume_opaque(self, opener: str) -> str:
        closer = "]" if opener == "[" else "}"
        start = self.pos
        depth = 0
        while self.pos < len(self.text):
            character = self.text[self.pos]
            if character == "\\":
                self.pos += min(2, len(self.text) - self.pos)
                continue
            self.pos += 1
            if character == opener:
                depth += 1
            elif character == closer:
                depth -= 1
                if depth == 0:
                    break
        return self.text[start : self.pos]

    def _consume_wildcard(self) -> str | None:
        end = self.text.find("__", self.pos + 2)
        if end < 0:
            return None
        start = self.pos
        self.pos = end + 2
        return self.text[start : self.pos]


def _extract_weight(children: list[Node]) -> tuple[Decimal, list[Node]]:
    if not children or not isinstance(children[-1], TextNode):
        return DEFAULT_WEIGHT, children
    trailing = children[-1].text
    separator = _last_unescaped_colon(trailing)
    if separator < 0:
        return DEFAULT_WEIGHT, children
    token = trailing[separator + 1 :].strip()
    if not NUMBER_RE.fullmatch(token):
        return DEFAULT_WEIGHT, children
    try:
        weight = Decimal(token)
    except InvalidOperation:
        return DEFAULT_WEIGHT, children
    if not weight.is_finite():
        return DEFAULT_WEIGHT, children
    prefix = trailing[:separator]
    content = list(children[:-1])
    if prefix:
        content.append(TextNode(prefix))
    return weight, content


def _last_unescaped_colon(text: str) -> int:
    last = -1
    position = 0
    while position < len(text):
        if text[position] == "\\":
            position += min(2, len(text) - position)
            continue
        if text[position] == ":":
            last = position
        position += 1
    return last


def _has_content(nodes: Sequence[Node]) -> bool:
    return any(
        isinstance(node, GroupNode) or bool(node.text.strip())
        for node in nodes
    )


def _format_weight(weight: Decimal) -> str:
    if weight.is_zero():
        return "0"
    rendered = format(weight, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered.startswith("+"):
        rendered = rendered[1:]
    return rendered


def _render(nodes: Sequence[Node]) -> str:
    parts: list[str] = []
    for node in nodes:
        if isinstance(node, TextNode):
            parts.append(node.text)
            continue
        if parts and parts[-1] and parts[-1][-1] in "0123456789.-":
            parts.append(" ")
        parts.append(f"{_format_weight(node.weight)}::")
        parts.append(_render(node.children))
        parts.append("::")
    return "".join(parts)


def convert_prompt(prompt: str) -> str:
    """Convert one Comfy/Anima prompt into NovelAI numeric-group syntax."""
    if not isinstance(prompt, str):
        raise TypeError("prompt must be a string")
    if not prompt:
        return ""
    return _render(Parser(prompt).parse())
