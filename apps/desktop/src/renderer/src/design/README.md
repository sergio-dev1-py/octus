# Sistema de diseno Octus (Todo 3, aprobado en ola 7)

Unica fuente de valores: `tokens.css`. `components.css`, `prototypes.html` y
(toda la ola 8 en adelante) solo usan `var(--oc-*)`.

- Temas: `data-theme="light" | "dark" | "system"` en el elemento raiz.
  `system` hereda claro y aplica oscuro con `prefers-color-scheme`.
- Densidades: `data-density="compact" | "normal" | "comfortable"`.
- Tamanos: `data-font-size="12".."18"` fija `--oc-font-base`.
- Paleta: neutros calidos propios; un solo acento (azul petroleo);
  semanticos (exito/aviso/peligro/info) reservados a estados, nunca decoracion.
- Iconografia: SVG monocromo de trazo (`stroke="currentColor"`), sin emojis
  ni iconos multicolor. Sin copiar la identidad de VS Code: nombres,
  marcas y disposiciones son propios de Octus.
- Componentes: `.oc-btn` (primary/danger/ghost), `.oc-input/.oc-select/
  .oc-textarea`, `.oc-card`, `.oc-banner` (warn/err/info), `.oc-pill`
  (ok/warn/err/accent), `.oc-dialog`, `.oc-table`, `.oc-empty`, `.oc-tabs`,
  `.oc-message`, `.oc-toolcall`, `.oc-code`, `.oc-icon`.
- Pantallas prototipadas en `prototypes.html`: bienvenida (`#welcome` con
  `#welcome-dropzone`), workbench (`#workbench` con `.message-timeline` y
  `#composer`), Agent Manager (`#screen-agents` con `#agent-dag`), Skills
  (`#screen-skills`) y MCP (`#screen-mcp`).
- Nota de peso PTY: `pty-weight-note.md` (PTY-directo confirmado con cifras).
- Sonda: `scripts/probe-task-3.mjs` (Node, sin dependencias pesadas).
