export const exampleAreas = [
  { id: "sources", title: "Источники проекта", shortTitle: "Источники", description: "Откуда берём информацию", colorKey: "olive", x: 20, y: 32, width: 268, height: 390 },
  { id: "review", title: "Сборка и проверка", description: "Объединяем и проверяем информацию", colorKey: "leaf", x: 336, y: 100, width: 846, height: 280 },
  { id: "result", title: "Карта и история", description: "Показываем устройство и сохраняем изменения", colorKey: "teal", x: 640, y: 468, width: 542, height: 258 },
];

export const exampleModules = [
  { id: "code", areaId: "sources", title: "Код проекта", description: "Файлы, структура и связи", icon: "code", x: 24, y: 92, width: 220, height: 116, ports: ["source-right"], status: null },
  { id: "dialogs", areaId: "sources", title: "Диалоги", description: "Вопросы и решения владельца", icon: "chat", x: 24, y: 250, width: 220, height: 116, ports: ["source-right"], status: null },
  { id: "builder", areaId: "review", title: "Сборка карты", description: "Собирает черновик карты", icon: "tree", x: 24, y: 96, width: 236, height: 172, ports: ["target-left", "source-right"], status: "planned" },
  { id: "facts", areaId: "review", title: "Проверка фактов", description: "Сверяет объяснения с кодом и источниками", icon: "verify", x: 310, y: 96, width: 236, height: 172, ports: ["target-left", "target-top", "source-right"], status: "ready" },
  { id: "clarity", areaId: "review", title: "Проверка понятности", description: "Проверяет ясность объяснений", icon: "list", x: 596, y: 96, width: 226, height: 172, ports: ["target-left", "source-bottom"], status: null },
  { id: "live", areaId: "result", title: "Живая карта", description: "Показывает устройство проекта", icon: "map", x: 24, y: 86, width: 224, height: 148, ports: ["target-left", "target-left-neutral", "source-right"], status: "verified" },
  { id: "history", areaId: "result", title: "История", description: "Сохраняет изменения", icon: "clock", x: 294, y: 86, width: 224, height: 148, ports: ["target-left"], status: null },
  { id: "owner", areaId: null, title: "Владелец проекта", description: "Вопросы и уточнения", icon: "user", x: 68, y: 560, width: 260, height: 116, ports: ["source-right"], status: null },
];

export const exampleConnections = [
  { id: "code-builder", source: "code", target: "builder", sourceHandle: "source-right", targetHandle: "target-left" },
  { id: "dialogs-builder", source: "dialogs", target: "builder", sourceHandle: "source-right", targetHandle: "target-left" },
  { id: "builder-facts", source: "builder", target: "facts", sourceHandle: "source-right", targetHandle: "target-left" },
  { id: "facts-clarity", source: "facts", target: "clarity", sourceHandle: "source-right", targetHandle: "target-left" },
  { id: "clarity-live", source: "clarity", target: "live", sourceHandle: "source-bottom", targetHandle: "target-left", route: "outside-group" },
  { id: "live-history", source: "live", target: "history", sourceHandle: "source-right", targetHandle: "target-left" },
  { id: "history-live", source: "history", target: "live", sourceHandle: "source-bottom", targetHandle: "target-bottom" },
  { id: "owner-live", source: "owner", target: "live", sourceHandle: "source-right", targetHandle: "target-left-neutral" },
  { id: "code-facts", source: "code", target: "facts", sourceHandle: "source-right", targetHandle: "target-top", route: "top-corridor" },
];
