# Repository Style Guide

This style-guide is used by the pi-review-agent `style` and `quality` personas.

## Indentation

- Use 2 spaces for indentation. Never use tabs or 4-space indentation.

## Naming

- Function names MUST use camelCase.
- Constant names SHOULD use UPPER_SNAKE_CASE.

## Imports

- Prefer explicit imports. Avoid `* as` namespace imports.

## Error handling

- Always handle promise rejections with try/catch or `.catch()`.
