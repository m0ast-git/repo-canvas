import React, { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, MarkerType, useNodesState, useReactFlow, useViewport } from "@xyflow/react";
import { Button, IconButton, StatusBadge, TextField, SelectField, ModuleCard, Inspector, Dialog, Notice } from "./components.jsx";
import * as Icons from "./icons.jsx";
import { sourceEdgeColor, describeEdge, AREA_TOKENS } from "./graph-theme.js";
import { canvasNodeTypes, canvasEdgeTypes, moduleIcons } from "./flow-components.jsx";
import { exampleAreas, exampleModules, exampleConnections } from "./example-map.js";
import { mergeReciprocalRoutes } from "../reciprocal-routes.js";
import "./catalog.css";

const areasById = new Map(exampleAreas.map(area => [area.id, area]));
const navItems = ["Карта", "Сценарии", "Решения", "Настройки"];
const descriptions = {
  code: ["Исходные файлы", "Структура и связи"], dialogs: ["Сообщения владельца", "Вопросы и решения"],
  builder: ["Код и диалоги", "Черновик карты"], facts: ["Черновик карты", "Проверенные утверждения"],
  clarity: ["Проверенные утверждения", "Понятное описание"], live: ["Проверенная карта", "Рабочая область"],
  history: ["Изменения проекта", "Сохранённые состояния"], owner: ["Объяснения проекта", "Вопросы и уточнения"],
};

function initialNodes() {
  return [
    ...exampleAreas.map(area => ({ id: "area-" + area.id, type: "rcArea", data: area, position: { x: area.x, y: area.y }, style: { width: area.width, height: area.height }, draggable: false, selectable: false, focusable: false, zIndex: -1 })),
    ...exampleModules.map(module => ({ id: module.id, type: "rcModule", position: { x: module.x, y: module.y }, ...(module.areaId ? { parentId: "area-" + module.areaId, extent: "parent" } : {}), style: { width: module.width, height: module.height }, data: { ...module, colorKey: areasById.get(module.areaId)?.colorKey }, selected: module.id === "facts", ariaLabel: module.title })),
  ];
}

function ThemeButton({ theme, onChange }) {
  return <IconButton label={theme === "light" ? "Включить тёмную тему" : "Включить светлую тему"} icon={theme === "light" ? Icons.MoonIcon : Icons.SunIcon} onClick={() => onChange(theme === "light" ? "dark" : "light")} />;
}

function Workspace({ theme, onTheme }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes());
  const [selectedId, setSelectedId] = useState("facts");
  const [navigation, setNavigation] = useState("Карта");
  const [structure, setStructure] = useState(false);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState("");
  const [edgeId, setEdgeId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [checkpoint, setCheckpoint] = useState(3);
  const flow = useReactFlow(), viewport = useViewport();
  const nodesById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const selected = nodesById.get(selectedId);
  const syncSelection = useCallback(({ nodes: chosen }) => setSelectedId(chosen.find(node => node.type === "rcModule")?.id || null), []);
  const edges = useMemo(() => mergeReciprocalRoutes(exampleConnections.map(connection => ({ ...connection, status: "confirmed", relations: [{ id: connection.id, from: connection.source, to: connection.target }] }))).map(connection => {
    const color = sourceEdgeColor(connection.source, nodesById, areasById);
    return { ...connection, type: "rcAreaEdge", selected: connection.id === edgeId, focusable: true, ariaLabel: describeEdge(connection, nodesById, areasById), markerStart: connection.bidirectional ? { type: MarkerType.ArrowClosed, color, orient: "auto-start-reverse", width: 12, height: 12 } : undefined, markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 }, data: { route: connection.route, color, description: describeEdge(connection, nodesById, areasById), relations: connection.relations } };
  }), [nodesById, edgeId]);
  const matches = query ? nodes.filter(node => node.type === "rcModule" && (node.data.title + " " + node.data.description).toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru"))).slice(0, 6) : [];
  const focusNode = useCallback((id, center = false) => {
    setSelectedId(id); setNavigation("Карта"); setEdgeId(null);
    setNodes(current => current.map(node => ({ ...node, selected: node.id === id })));
    if (center) requestAnimationFrame(() => flow.fitView({ nodes: [{ id }], padding: .6, maxZoom: 1, duration: 180 }));
  }, [flow, setNodes]);
  const reset = () => { setNodes(initialNodes()); setSelectedId("facts"); setNavigation("Карта"); setEdgeId(null); setCheckpoint(3); requestAnimationFrame(() => flow.fitView({ padding: .04, maxZoom: 1 })); };
  const openCorrection = () => { setDraft(selected.data.description); setEditError(""); setDialog("correction"); };
  const saveCorrection = () => {
    if (!draft.trim()) { setEditError("Напишите пояснение к элементу."); return; }
    setNodes(current => current.map(node => node.id === selectedId ? { ...node, data: { ...node.data, description: draft.trim() } } : node));
    setDialog(null);
  };

  return <div className="rc-example-app">
    <header className="rc-app-header">
      <a className="rc-brand" href="#workspace" onClick={event => { event.preventDefault(); reset(); }}><Icons.TreeStructureIcon size={26} aria-hidden="true" /><strong>Repo Canvas</strong></a>
      <nav aria-label="Разделы примера">{navItems.map(item => <button key={item} aria-current={navigation === item ? "page" : undefined} onClick={() => { setNavigation(item); setQuery(""); }}>{item}</button>)}</nav>
      <div className="rc-search-slot"><Icons.MagnifyingGlassIcon size={18} aria-hidden="true" /><input aria-label="Найти в примерной карте" placeholder="Найти в проекте…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "Escape") setQuery("");
        if (event.key === "Enter" && matches[0]) { focusNode(matches[0].id, true); setQuery(""); }
      }} />
        {query && <div className="rc-search-results" aria-label="Результаты поиска">{matches.length ? matches.map(node => <button key={node.id} onClick={() => { focusNode(node.id, true); setQuery(""); }}>{node.data.title}</button>) : <p>Ничего не найдено</p>}</div>}
      </div>
      <ThemeButton theme={theme} onChange={onTheme} />
    </header>
    <div className="rc-example-workspace">
      <div className="rc-map-column">
        <div className="rc-map-toolbar"><Button icon={Icons.FolderSimpleIcon} aria-expanded={structure} aria-controls="rc-structure" onClick={() => setStructure(!structure)}>Структура<Icons.CaretDownIcon size={14} /></Button><span>Построить и принять карту</span><Button className="rc-build-action" icon={Icons.TreeStructureIcon} onClick={() => setDialog("build")}>Построить карту</Button></div>
        <div className={"rc-canvas rc-example-canvas" + (viewport.zoom < .78 ? " is-overview" : "") + (viewport.zoom < .45 ? " is-distant" : "")} style={{ "--rc-zoom": viewport.zoom }}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={canvasNodeTypes} edgeTypes={canvasEdgeTypes} onNodesChange={onNodesChange} onSelectionChange={syncSelection}
            onNodeClick={(_, node) => { if (node.type === "rcModule") focusNode(node.id); }} onPaneClick={() => { setSelectedId(null); setEdgeId(null); setNodes(current => current.map(node => ({ ...node, selected: false }))); }}
            onEdgeClick={(_, edge) => setEdgeId(edge.id)} onNodeDragStart={() => setEdgeId(null)}
            fitView fitViewOptions={{ padding: .04, maxZoom: 1 }} minZoom={.25} maxZoom={1.6} nodesConnectable={false} deleteKeyCode={null}
            proOptions={{ hideAttribution: true }} selectionOnDrag={false} ariaLabelConfig={{ "node.a11yDescription.default": "Нажмите Enter, чтобы выбрать элемент. Стрелки перемещают его в пределах области.", "edge.a11yDescription.default": "Нажмите Enter, чтобы выбрать связь." }} />
          {structure && <aside className="rc-structure" id="rc-structure" aria-label="Структура примера"><header><strong>Области проекта</strong><IconButton icon={Icons.XIcon} label="Закрыть структуру" onClick={() => setStructure(false)} /></header>
            {exampleAreas.map(area => <section key={area.id}><h3><i style={{ background: AREA_TOKENS[area.colorKey] }} />{area.title}</h3>{nodes.filter(node => node.data.areaId === area.id && node.type === "rcModule").map(node => <button key={node.id} aria-pressed={selectedId === node.id} onClick={() => { focusNode(node.id, true); setStructure(false); }}>{node.data.title}</button>)}</section>)}
          </aside>}
          <div className="rc-canvas-controls"><IconButton icon={Icons.MinusIcon} label="Отдалить карту" onClick={() => flow.zoomOut()} /><output aria-label="Масштаб карты">{Math.round(viewport.zoom * 100)}%</output><IconButton icon={Icons.PlusIcon} label="Приблизить карту" onClick={() => flow.zoomIn()} /><IconButton icon={Icons.ArrowsOutSimpleIcon} label="Показать всю карту" onClick={() => flow.fitView({ padding: .04, maxZoom: 1, duration: 180 })} /></div>
          {edgeId && <div className="rc-edge-hint" role="status">{edges.find(edge => edge.id === edgeId)?.data.description}<button aria-label="Закрыть описание связи" onClick={() => setEdgeId(null)}><Icons.XIcon size={16} /></button></div>}
        </div>
        <section className="rc-example-history" aria-label="Пример истории">
          <div><strong>История</strong><small>Ключевые состояния карты</small></div>
          <div className="rc-history-slider"><input type="range" min="0" max="3" step="1" value={checkpoint} aria-label="Состояние примерной карты" onChange={event => setCheckpoint(Number(event.target.value))} /><div>{["7 сен", "8 сен", "9 сен", "Live"].map((label, i) => <span className={checkpoint === i ? "is-current" : ""} key={label}>{label}</span>)}</div></div>
          <Button variant="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Показать детали<Icons.CaretDownIcon size={14} /></Button>
          {historyOpen && <div className="rc-history-description"><StatusBadge status="ready">{checkpoint === 3 ? "Текущее состояние" : "Состояние от " + (checkpoint + 7) + " сентября"}</StatusBadge><p>Это интерактивный образец шкалы. История вашего проекта здесь не изменяется.</p></div>}
        </section>
      </div>
      {navigation === "Карта" && selected && <Inspector title={selected.data.title} status={selected.data.status || "ready"} onClose={() => focusNode(null)} actions={<><Button variant="primary" onClick={openCorrection}>Уточнить смысл</Button><Button variant="link" icon={Icons.ArrowSquareOutIcon} onClick={() => setDialog("sources")}>Показать источники</Button></>}>
        <p>{selected.data.description}</p><dl><div><dt>Получает</dt><dd>{descriptions[selectedId]?.[0]}</dd></div><div><dt>Передаёт</dt><dd>{descriptions[selectedId]?.[1]}</dd></div></dl>
        <p className="rc-inspector-meta">{areasById.get(selected.data.areaId)?.title || "Вне областей"}</p>
      </Inspector>}
      {navigation !== "Карта" && <Inspector title={navigation} onClose={() => setNavigation("Карта")}>
        {navigation === "Сценарии" && <><p>Построить и принять карту</p><ol className="rc-scenario-list">{["code", "builder", "facts", "clarity", "live"].map(id => <li key={id}><button onClick={() => focusNode(id, true)}>{nodesById.get(id).data.title}</button></li>)}</ol></>}
        {navigation === "Решения" && <ul className="rc-rule-list"><li>Белый канвас #FFFFFF.</li><li>Акцент выбора — тёмный зелёный.</li><li>Связи наследуют цвет области источника.</li><li>Одна верхняя навигация.</li></ul>}
        {navigation === "Настройки" && <><p>Параметры компонентов показаны в разделе «Компоненты». Переключение темы находится в верхней строке.</p><Button onClick={reset}>Сбросить пример карты</Button><p className="rc-inspector-meta">Пример использует локальные данные каталога. Настройки рабочего проекта не затрагиваются.</p></>}
      </Inspector>}
    </div>
    <Dialog open={dialog === "correction"} title="Уточнить пояснение" onClose={() => setDialog(null)} actions={<><Button onClick={() => setDialog(null)}>Отмена</Button><Button variant="primary" onClick={saveCorrection}>Применить в примере</Button></>}><TextField multiline label="Пояснение к элементу" value={draft} onChange={event => { setDraft(event.target.value); setEditError(""); }} error={editError} hint="Правка применяется только к этому примеру компонента." /></Dialog>
    <Dialog open={dialog === "sources"} title="Источники в примере" onClose={() => setDialog(null)} actions={<Button onClick={() => setDialog(null)}>Понятно</Button>}><p>В рабочем интерфейсе здесь откроются подтверждающие фрагменты кода и диалогов. Каталог показывает состояние панели, не читая источники вашего проекта.</p></Dialog>
    <Dialog open={dialog === "build"} title="Построение карты" onClose={() => setDialog(null)} actions={<Button onClick={() => setDialog(null)}>Закрыть</Button>}><Notice title="Каталог компонентов">Эта кнопка показывает оформление действия. Реальное построение запускается в рабочем проекте.</Notice><a className="rc-project-link" href="/">Открыть рабочий проект<Icons.ArrowSquareOutIcon size={16} /></a></Dialog>
  </div>;
}

function ComponentCatalog() {
  const [status, setStatus] = useState("ready"), [selected, setSelected] = useState(true), [name, setName] = useState("Проверка фактов"), [email, setEmail] = useState("");
  const [dialog, setDialog] = useState(false), [notified, setNotified] = useState(false);
  const colors = [["Акцент выбора", "--rc-accent"], ["Исходящие: олива", "--rc-area-olive"], ["Исходящие: зелень", "--rc-area-leaf"], ["Исходящие: бирюза", "--rc-area-teal"], ["Нейтральная связь", "--rc-edge-neutral"], ["Канвас", "--rc-canvas"]];
  return <main className="rc-component-catalog">
    <header><p className="rc-kicker">Repo Canvas / Система интерфейса 1.0</p><h1>Один язык для всей карты</h1><p>Компоненты ниже используются в соседнем примере рабочей области. Их цвета и состояния меняются вместе.</p></header>
    <section><div className="rc-section-heading"><h2>Цвета</h2><p>Выбор, принадлежность и статус — самостоятельные роли.</p></div><div className="rc-swatches">{colors.map(([name, token]) => <div key={token}><span style={{ background: "var(" + token + ")" }} /><strong>{name}</strong><code>{token}</code></div>)}</div></section>
    <section className="rc-catalog-columns"><div><div className="rc-section-heading"><h2>Кнопки и состояния</h2><p>Один основной акцент на смысловую группу.</p></div><div className="rc-control-samples"><Button variant="primary" onClick={() => setDialog(true)}>Уточнить смысл</Button><Button icon={Icons.FolderSimpleIcon} onClick={() => setNotified(!notified)}>Структура</Button><Button variant="link" icon={Icons.ArrowSquareOutIcon} onClick={() => setDialog(true)}>Источники</Button><Button loading>Проверяем</Button><Button disabled>Недоступно</Button></div>{notified && <Notice title="Состояние изменено">Вторичная кнопка работает без изменения основного акцента.</Notice>}<div className="rc-status-samples">{["ready", "verified", "planned", "running", "paused", "question", "error"].map(value => <StatusBadge key={value} status={value} />)}</div></div>
      <div><div className="rc-section-heading"><h2>Узел</h2><p>Выбор меняет заливку, сохраняя размер и статус.</p></div><div className="rc-node-sample"><ModuleCard title={name || "Название элемента"} description="Сверяет объяснения с кодом и источниками." selected={selected} status={status} icon={Icons.FileMagnifyingGlassIcon} /></div><div className="rc-control-samples"><Button aria-pressed={selected} onClick={() => setSelected(!selected)}>{selected ? "Снять выделение" : "Выбрать узел"}</Button></div><SelectField label="Статус узла" value={status} onChange={event => setStatus(event.target.value)}>{["ready", "planned", "running", "question", "error"].map(value => <option value={value} key={value}>{({ ready: "В системе", planned: "Запланировано", running: "В работе", question: "Нужен ответ", error: "Ошибка" })[value]}</option>)}</SelectField></div></section>
    <section className="rc-catalog-columns"><div><div className="rc-section-heading"><h2>Типографика</h2><p>IBM Plex Sans: локально, с кириллицей и настоящими начертаниями.</p></div><div className="rc-type-samples"><span style={{ fontSize: "32px", fontWeight: 600 }}>Устройство проекта</span><span style={{ fontSize: "26px", fontWeight: 600 }}>Проверка фактов</span><span style={{ fontSize: "18px", fontWeight: 600 }}>Название узла</span><span>Понятное объяснение на русском языке. № 123 — 09.09.2026</span><small>Подпись источника · 12 px</small><code>source.areaId → edge.color</code></div></div><div><div className="rc-section-heading"><h2>Поля</h2><p>Подпись остаётся видимой, ошибка описана словами.</p></div><div className="rc-form-samples"><TextField label="Название элемента" value={name} onChange={event => setName(event.target.value)} hint="Название меняется в образце узла выше." /><TextField label="Обязательное пояснение" value={email} onChange={event => setEmail(event.target.value)} error={!email.trim() ? "Добавьте пояснение, чтобы продолжить." : ""} placeholder="Что делает этот элемент?" /></div></div></section>
    <section><div className="rc-section-heading"><h2>Ритм и размеры</h2><p>Шаг 4 px; длинные подписи расширяют компонент по высоте.</p></div><div className="rc-spacing-samples">{[4, 8, 12, 16, 24, 32, 48].map(size => <div key={size}><span style={{ width: size, height: size }} /><code>{size} px</code></div>)}</div><div className="rc-dimensions"><span>Кнопка: 36 px</span><span>Панель: 320 px</span><span>Отступ панели: 24 px</span><span>Отступ узла: 16 px</span><span>Скругление узла: 8 px</span><span>Линия: 1.8 / 2.6 px</span></div></section>
    <Dialog open={dialog} title="Диалог компонента" onClose={() => setDialog(false)} actions={<><Button onClick={() => setDialog(false)}>Отмена</Button><Button variant="primary" onClick={() => setDialog(false)}>Готово</Button></>}><p>Фокус остаётся внутри диалога. Escape закрывает его и возвращает фокус к кнопке, которая открыла окно.</p><TextField label="Комментарий" multiline placeholder="Введите пример текста" /></Dialog>
  </main>;
}

function Rules() {
  return <main className="rc-component-catalog rc-written-rules"><header><p className="rc-kicker">Принятые решения</p><h1>«Родственные зелёные»</h1><p>Светлая тема следует выбранному референсу №1. Для тёмной сохранены графит и янтарное выделение из ранее принятого направления.</p></header>
    <section><h2>Приоритеты</h2><ol><li>Выбранный узел — главное пятно цвета.</li><li>Связи сообщают, из какой области приходит информация.</li><li>Название и пояснение читаются раньше служебных меток.</li><li>Инструменты и панели раскрываются по необходимости.</li></ol></section>
    <section><h2>Цвет связей</h2><p>Вся линия наследует цвет области исходного узла. Целевая область, наведение и выбор не заменяют этот цвет. Если у источника нет области, линия серая.</p><p>Близость оттенков поддерживает гармонию. Подпись источника и стрелка остаются дополнительными средствами различения. Новые области получают устойчивое назначение цвета; перестановка списка не должна менять цвета.</p></section>
    <section><h2>Маршруты и взаимообмен</h2><p>Заголовок области, её описание и отступ вокруг них — защищённая зона. Ни линия, ни стрелка, ни подпись связи не могут заходить в неё при масштабе, переносе или изменении текста.</p><p>Взаимообмен может отображаться одной линией с двумя стрелками. Исходные направления и их данные сохраняются отдельно. В примере «Живая карта ↔ История» используется один маршрут. Для объединения направлений между разными областями необходимо сохранить информацию о цвете обоих источников; этот вариант будет проверяться при внедрении в рабочий маршрутизатор.</p></section>
    <section><h2>Белый канвас</h2><p>В светлой теме поле, области и обычные карточки используют #FFFFFF. Нет тонированной подложки, фоновой сетки, свечения и пульсации.</p></section>
    <section><h2>Состояния</h2><p>Статус задаётся текстом и знаком. Выбранный элемент может быть готовым, запланированным или требовать ответа — заливка выбора не подменяет эти значения.</p></section>
    <section><h2>Компоновка</h2><p>Глобальная навигация одна. Структура открывается по кнопке, сведения — справа. На узком экране сведения занимают доступную ширину; закрытие возвращает к карте. История имеет один контроль раскрытия.</p></section>
    <section><h2>Для интеграции</h2><p>Токены, React-компоненты и компоненты React Flow находятся в client/src/design-system. Этот каталог проверяет их на локальном примере. Рабочий экран проекта пока использует свои прежние стили; его перенос на эту систему — следующий этап.</p></section>
  </main>;
}

function Catalog() {
  const [theme, setTheme] = useState("light"), [page, setPage] = useState("workspace");
  return <div className="rc-system rc-catalog-shell" data-rc-theme={theme}>
    <header className="rc-catalog-bar"><span>Дизайн-система <b>1.0</b></span><nav aria-label="Разделы дизайн-системы">{[["workspace", "Рабочая область"], ["components", "Компоненты"], ["rules", "Правила"]].map(([id, title]) => <button key={id} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>{title}</button>)}</nav><div>{page !== "workspace" && <ThemeButton theme={theme} onChange={setTheme} />}<a href="/" title="Открыть рабочий проект">Проект<Icons.ArrowSquareOutIcon size={16} /></a></div></header>
    {page === "workspace" ? <ReactFlowProvider><Workspace theme={theme} onTheme={setTheme} /></ReactFlowProvider> : page === "components" ? <ComponentCatalog /> : <Rules />}
  </div>;
}

createRoot(document.getElementById("design-system-root")).render(<Catalog />);
