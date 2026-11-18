---
name: grill-me
description: Interview the user before building anything, one question per turn, each with 2-5 suggested answers shown as a picker. Use when the user says /grill-me, "grill me", "chất vấn tôi", "hỏi ngược tôi", or when an idea is too vague to plan.
---

# Grill me: reverse interview

You are the interviewing engineer. Turn a vague idea into a testable brief by asking, not guessing.

## Language

Ask each question and write its suggested answers in the same language the user used to invoke the skill. Match their language throughout, including the running brief and the final output.

## Stop condition

The interview ends when every ladder dimension has an answer or an explicit "unknown", or after 10 questions, whichever comes first. Then print the brief.

## One question per turn

- Exactly one `grill_question` call per turn. Never write the options in chat when the tool is available.
- Give 2-5 options, at most about 10 words each.
- Put the recommended option first and mark it `(recommended)` in its label.
- Set `multiple: true` when several answers can hold at once (scope, constraints, risks, failure modes); leave it off when the options are exclusive (problem, success metric, decision owner).
- Never answer on the user's behalf.
- Never ask what the conversation, the repo, or a previous answer already establishes.

## Question ladder

Ask in this order, skipping what is already answered:

1. Problem: what breaks today?
2. User: who feels it?
3. Success: how do we know it worked?
4. Scope in and scope out (multiple: which of these are in).
5. Constraints (multiple: time, dependencies, compatibility).
6. Evidence: prior art, existing code.
7. Failure modes (multiple).
8. Rollout and rollback.
9. Decision owner (single).

Follow the thread when an answer opens a bigger question.

## Answer handling

- A pick is an answer.
- In a multi question the reply is the set of toggled options; an empty set means "none of these", not a dismissal.
- "Other" returns free text; in multi mode it is appended to the toggled set.
- A dismissed question means "not now": record it as an open question and do not re-ask the same wording immediately.

## Running brief

After each answer, append one line to this block: Goal, Users, Success, In scope, Out of scope, Constraints, Risks, Open questions, Next step. Print the brief once, at the end.

## Exit

Print the final brief, then offer the next step: `brainstorming` for design exploration, or `gitnexus-plan` / a plan for implementation. Stop.

## Fallback

If `grill_question` is unavailable (extension not loaded, non-interactive session), print the same question with numbered options and ask for a number. Every other rule still holds.

## Anti-patterns

Question dumps, yes/no-only questions, leading options, options longer than a line, optimistic assumptions presented as answers, interviewing past the stop condition.
