flowchart TD
  %% Big LLM First — Prompts & Phases
  U["User Message"] --> SYS["meta_agent.md as System<br/>(governs Analyze→Plan→Act→Blend)"]
  SYS --> PLAN["Planning (LLM)<br/>CONTROL JSON: route, missing, consent, calls"]
  PLAN --> ACT["Execution (LLM tools loop)<br/>chatWithToolsLLM"]
  ACT --> BLEND["Blend (LLM)<br/>Compose grounded reply from receipts"]
  BLEND --> RECEIPTS["Persist receipts (facts, decisions, reply)"]
  RECEIPTS --> VERQ{"/why or AUTO_VERIFY?"}
  VERQ -->|Yes| VERIFY["verify.md<br/>STRICT JSON verdict + scores"]
  VERIFY --> OUT
  VERQ -->|No| OUT["Return to user"]

  %% Notes
  subgraph NOTES[Prompt Notes]
    N1["Single governing meta_agent.md: includes routing, slot guidance, consent gates, policy rules, and groundedness."]
    N2["Planning prompt is an inline CONTROL_REQUEST (strict JSON) appended by the tools runner; no separate file."]
    N3["Auxiliary prompt used: complexity_assessor.md (optional) to hint deep research budget."]
    N4["Verification uses verify.md (STRICT JSON); never leaks chain-of-thought."]
  end
