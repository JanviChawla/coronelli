from dataclasses import dataclass


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    path: str
    message: str
