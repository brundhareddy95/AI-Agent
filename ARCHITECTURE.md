# Architecture

```text
Next.js / React
      |
      | GraphQL
      v
   Hasura
      |
      +---- PostgreSQL
      |
      +---- Actions ------> Workflow Engine
      |
      +---- Event Triggers
      |
      +---- Scheduled Events

Workflow Engine
      |
      +---- LLM API
      +---- External HTTP APIs
      +---- PostgreSQL through Hasura
```

The system has two authorization layers:

1. Organization/role authorization through `org_members`.
2. Sensitive step and approval authorization inside the workflow Action handler.
