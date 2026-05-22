const { ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, setIcon } = require("obsidian");

const VIEW_TYPE = "civil-service-dashboard-view";
const DIARY_FOLDER = "日记";
const MISTAKE_FOLDER = "错题";
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DEFAULT_PLAN_TEMPLATE = [
  "资料分析第 1 套",
  "资料分析第 2 套",
  "言语理解第 1 套",
];

function createDefaultDailyData(date, planTemplate = DEFAULT_PLAN_TEMPLATE) {
  const plan = createPlanFromTemplate(planTemplate);
  return {
    date,
    plan,
    practice: {
      items: syncPracticeItems(plan),
      mistakeLink: buildMistakeLink(date),
    },
    review: "",
  };
}

function renderDailyMarkdown(data) {
  const plan = Array.isArray(data.plan) ? data.plan : [];
  const practice = {
    ...createDefaultDailyData(data.date).practice,
    ...data.practice,
  };
  practice.items = syncPracticeItems(plan, practice.items);

  const lines = [`# 考公日记 ${data.date}`, "", "## 本日计划", ""];
  if (plan.length === 0) {
    lines.push("- [ ] ");
  } else {
    for (const task of plan) {
      lines.push(`- [${task.checked ? "x" : " "}] ${task.text || ""}`);
    }
  }

  lines.push(
    "",
    "## 本日做题情况",
    "",
    "| 项目 | 总题数 | 正确数 | 正确率 | 用时 | 错题 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...practice.items.map((item, index) => {
      const section = buildMistakeSections(plan)[index];
      const mistakeLink = section ? buildPlanMistakeLink(data.date, section.title) : "";
      return [
        "",
        item.text,
        item.total,
        item.correct,
        item.accuracy,
        item.duration,
        mistakeLink,
      ].map(escapeTableCell).join(" | ").replace(/^ \| /, "| ") + " |";
    }),
    "",
    "## 复盘",
    "",
    data.review || "",
    ""
  );

  return lines.join("\n");
}

function parseDailyMarkdown(markdown, fallbackDate) {
  const data = createDefaultDailyData(extractDate(markdown) || fallbackDate);
  const planSection = extractSection(markdown, "本日计划");
  const practiceSection = extractSection(markdown, "本日做题情况");
  const parsedPlan = parsePlan(planSection);
  if (parsedPlan.length > 0) data.plan = parsedPlan;
  data.practice = {
    ...data.practice,
    ...parsePractice(practiceSection, data.plan, data.date),
  };
  if (!String(data.practice.mistakeLink || "").trim()) {
    data.practice.mistakeLink = buildMistakeLink(data.date);
  }
  data.practice.items = syncPracticeItems(data.plan, data.practice.items);
  data.review = extractSection(markdown, "复盘").trim();
  return data;
}

function pickLatestDailyPath(paths, diaryFolder) {
  const prefix = `${trimSlashes(diaryFolder)}/`;
  return paths
    .map((path) => {
      if (!path.startsWith(prefix)) return null;
      const fileName = path.slice(prefix.length);
      const match = fileName.match(DAILY_FILE_RE);
      if (!match) return null;
      return { path, date: match[1] };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.path || null;
}

function calculateCompletion(plan) {
  const total = Array.isArray(plan) ? plan.length : 0;
  const done = Array.isArray(plan) ? plan.filter((task) => task.checked).length : 0;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

function calculateAccuracy(totalValue, correctValue) {
  const total = parseNumber(totalValue);
  const correct = parseNumber(correctValue);
  if (!total || total <= 0) return "0%";
  const value = Math.round((correct / total) * 100);
  return `${Math.max(0, Math.min(100, value))}%`;
}

function calculatePracticeSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const total = list.reduce((sum, item) => sum + parseNumber(item && item.total), 0);
  const correct = list.reduce((sum, item) => sum + parseNumber(item && item.correct), 0);
  return {
    total,
    correct,
    accuracy: calculateAccuracy(String(total), String(correct)),
  };
}

function syncPracticeItems(plan, items = []) {
  const sourceItems = Array.isArray(items) ? items : [];
  return (Array.isArray(plan) ? plan : []).map((task, index) => {
    const previous = sourceItems[index] || {};
    const total = stringValue(previous.total);
    const correct = stringValue(previous.correct);
    return {
      text: stringValue(task && task.text),
      total,
      correct,
      accuracy: calculateAccuracy(total, correct),
      duration: stringValue(previous.duration),
    };
  });
}

function normalizePlanTemplate(planTemplate) {
  const source = Array.isArray(planTemplate) ? planTemplate : DEFAULT_PLAN_TEMPLATE;
  const normalized = source
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    })
    .map((text) => text.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...DEFAULT_PLAN_TEMPLATE];
}

function createPlanFromTemplate(planTemplate) {
  return normalizePlanTemplate(planTemplate).map((text) => ({ text, checked: false }));
}

function buildMistakePath(date) {
  return `${MISTAKE_FOLDER}/${date}.md`;
}

function buildMistakeLink(date) {
  return `[[${MISTAKE_FOLDER}/${date}]]`;
}

function buildPlanMistakeLink(date, sectionTitle) {
  return `[[${MISTAKE_FOLDER}/${date}#${sectionTitle}]]`;
}

function renderMistakeMarkdown(date, plan = []) {
  return ensureMistakePlanSections(renderMistakeBase(date), date, plan);
}

function ensureMistakePlanSections(markdown, date, plan = []) {
  const source = markdown || renderMistakeBase(date);
  const sections = buildMistakeSections(plan).filter((section) => !hasHeading(source, section.title));
  if (sections.length === 0) return source;

  const sectionText = sections.map((section) => renderMistakeSection(section.title)).join("\n");
  const lines = source.split(/\r?\n/);
  const reviewIndex = lines.findIndex((line) => line.trim() === "## 回看");
  if (reviewIndex === -1) {
    return `${source.replace(/\s*$/, "\n\n")}${sectionText}`;
  }

  const before = lines.slice(0, reviewIndex).join("\n").replace(/\s*$/, "");
  const after = lines.slice(reviewIndex).join("\n").replace(/^\s*/, "");
  return `${before}\n\n${sectionText}\n${after}`.replace(/\s*$/, "\n");
}

function renderMistakeBase(date) {
  return [
    `# 错题 ${date}`,
    "",
    "## 回看",
    "",
    "- [ ] 1 天后",
    "- [ ] 3 天后",
    "- [ ] 7 天后",
    "",
  ].join("\n");
}

function buildMistakeSections(plan) {
  const counts = new Map();
  return normalizePlanTemplate(plan).map((text) => {
    const count = (counts.get(text) || 0) + 1;
    counts.set(text, count);
    return { title: count === 1 ? text : `${text}（${count}）` };
  });
}

function renderMistakeSection(title) {
  return [
    `## ${title}`,
    "",
    "### 错题 1",
    "",
    "- 题目：",
    "- 错因：",
    "- 正解：",
    "",
  ].join("\n");
}

function hasHeading(markdown, title) {
  return markdown.split(/\r?\n/).some((line) => line.trim() === `## ${title}`);
}

function extractDate(markdown) {
  const titleMatch = markdown.match(/^#\s+考公日记\s+(\d{4}-\d{2}-\d{2})\s*$/m);
  return titleMatch ? titleMatch[1] : "";
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";
  const sectionLines = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    sectionLines.push(lines[index]);
  }
  return sectionLines.join("\n").trim();
}

function parsePlan(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^- \[([ xX])\]\s*(.*)$/))
    .filter(Boolean)
    .map((match) => ({ checked: match[1].toLowerCase() === "x", text: match[2].trim() }));
}

function parsePractice(section, plan = [], date = "") {
  const detailed = parseDetailedPractice(section);
  if (detailed) {
    return {
      items: syncPracticeItems(plan, detailed),
      mistakeLink: buildMistakeLink(date),
    };
  }

  const fieldMap = {
    "行测题数": "xingceTotal",
    "正确数": "xingceCorrect",
    "正确率": "accuracy",
    "申论练习": "shenlun",
    "学习时长": "studyTime",
    "错题链接": "mistakeLink",
  };
  const practice = {};
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (!match) continue;
    const key = fieldMap[match[1].trim()];
    if (key) practice[key] = unescapeTableCell(match[2].trim());
  }
  const items = syncPracticeItems(plan);
  if (items[0]) {
    items[0] = {
      ...items[0],
      total: stringValue(practice.xingceTotal),
      correct: stringValue(practice.xingceCorrect),
      accuracy: calculateAccuracy(practice.xingceTotal, practice.xingceCorrect),
      duration: stringValue(practice.studyTime),
    };
  }
  return {
    ...practice,
    items,
  };
}

function parseDetailedPractice(section) {
  const rows = section
    .split(/\r?\n/)
    .map(parseTableRow)
    .filter(Boolean);
  const headerIndex = rows.findIndex((row) => row[0] === "项目" && row[1] === "总题数");
  if (headerIndex === -1) return null;

  return rows
    .slice(headerIndex + 1)
    .filter((row) => !row.every((cell) => /^-+$/.test(cell)))
    .map((row) => {
      const total = stringValue(row[1]);
      const correct = stringValue(row[2]);
      return {
        text: stringValue(row[0]),
        total,
        correct,
        accuracy: calculateAccuracy(total, correct),
        duration: stringValue(row[4]),
      };
    })
    .filter((item) => item.text || item.total || item.correct || item.duration);
}

function parseTableRow(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return null;
  return text
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => unescapeTableCell(cell.trim()));
}

function parseNumber(value) {
  const numeric = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function escapeTableCell(value) {
  return String(value || "").replace(/\n/g, " ").replace(/\|/g, "\\|");
}

function unescapeTableCell(value) {
  return String(value || "").replace(/\\\|/g, "|");
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

class CivilServiceDashboardPlugin extends Plugin {
  async onload() {
    this.settings = await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new CivilServiceDashboardView(leaf, this));
    this.addSettingTab(new CivilServiceDashboardSettingTab(this.app, this));

    this.addRibbonIcon("home", "打开考公工作台", () => {
      this.openDashboard();
    });

    this.addCommand({
      id: "open-civil-service-dashboard",
      name: "考公工作台：打开工作台",
      callback: () => this.openDashboard(),
    });

    this.addCommand({
      id: "create-today-civil-service-record",
      name: "考公工作台：创建/切换到今日记录",
      callback: () => this.createOrSwitchTodayRecord(),
    });

  }

  async loadSettings() {
    const data = await this.loadData();
    return {
      planTemplate: normalizePlanTemplate(data && data.planTemplate),
    };
  }

  getPlanTemplate() {
    return normalizePlanTemplate(this.settings && this.settings.planTemplate);
  }

  async setPlanTemplate(planTemplate) {
    this.settings = {
      ...this.settings,
      planTemplate: normalizePlanTemplate(planTemplate),
    };
    await this.saveData(this.settings);
  }

  async openDashboard() {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existingLeaf || this.app.workspace.getLeaf("tab");
    if (!existingLeaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async createOrSwitchTodayRecord() {
    const leaf = await this.openDashboard();
    if (leaf.view instanceof CivilServiceDashboardView) {
      await leaf.view.switchToToday();
    }
  }
}

class CivilServiceDashboardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "考公工作台设置" });

    new Setting(containerEl)
      .setName("每日清单模板")
      .setDesc("一行一个计划项。点击工作台日历按钮创建新日期时，会用这些行生成本日计划。")
      .addTextArea((text) => {
        text
          .setPlaceholder("资料分析第 1 套\n资料分析第 2 套\n言语理解第 1 套")
          .setValue(this.plugin.getPlanTemplate().join("\n"))
          .onChange(async (value) => {
            await this.plugin.setPlanTemplate(value.split(/\r?\n/));
          });
        text.inputEl.rows = 8;
        text.inputEl.cols = 32;
      });
  }
}

class CivilServiceDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentFile = null;
    this.data = null;
    this.saveTimer = null;
    this.lastWrittenText = "";
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "考公工作台";
  }

  getIcon() {
    return "graduation-cap";
  }

  async onOpen() {
    this.registerVaultListeners();
    await this.loadLatestOrToday();
  }

  async onClose() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveNow();
    }
  }

  registerVaultListeners() {
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || !this.currentFile || file.path !== this.currentFile.path) {
          return;
        }
        const text = await this.app.vault.read(file);
        if (text === this.lastWrittenText) return;
        this.data = parseDailyMarkdown(text, dateFromPath(file.path) || formatDate(new Date()));
        this.render();
      })
    );

    const refreshDates = () => this.renderDateList();
    this.registerEvent(this.app.vault.on("create", refreshDates));
    this.registerEvent(this.app.vault.on("delete", refreshDates));
    this.registerEvent(this.app.vault.on("rename", refreshDates));
  }

  async loadLatestOrToday() {
    const paths = this.app.vault.getMarkdownFiles().map((file) => file.path);
    const latestPath = pickLatestDailyPath(paths, DIARY_FOLDER);
    if (latestPath) {
      const latestFile = this.app.vault.getFileByPath(latestPath);
      if (latestFile instanceof TFile) {
        await this.loadFile(latestFile);
        return;
      }
    }
    await this.switchToToday();
  }

  async switchToToday() {
    const today = formatDate(new Date());
    const file = await this.getOrCreateDailyFile(today);
    await this.loadFile(file);
    new Notice(`已切换到 ${today} 的考公记录`);
  }

  async getOrCreateDailyFile(date) {
    await this.ensureDiaryFolder();
    const path = `${DIARY_FOLDER}/${date}.md`;
    const existing = this.app.vault.getFileByPath(path);
    if (existing instanceof TFile) return existing;

    const markdown = renderDailyMarkdown(createDefaultDailyData(date, this.plugin.getPlanTemplate()));
    return this.app.vault.create(path, markdown);
  }

  async openDailyMistakeNote() {
    if (!this.currentFile || !this.data) return;
    const date = this.data.date || dateFromPath(this.currentFile.path) || formatDate(new Date());
    const file = await this.getOrCreateMistakeFile(date, this.data.plan);
    this.data.practice.mistakeLink = buildMistakeLink(date);
    await this.saveNow();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async openPlanMistakeNote(index) {
    if (!this.currentFile || !this.data) return;
    const date = this.data.date || dateFromPath(this.currentFile.path) || formatDate(new Date());
    const sections = buildMistakeSections(this.data.plan);
    const section = sections[index];
    if (!section) {
      await this.openDailyMistakeNote();
      return;
    }

    const file = await this.getOrCreateMistakeFile(date, this.data.plan);
    this.data.practice.mistakeLink = buildMistakeLink(date);
    await this.saveNow();

    const sourcePath = this.currentFile.path;
    const linkText = `${MISTAKE_FOLDER}/${date}#${section.title}`;
    if (typeof this.app.workspace.openLinkText === "function") {
      await this.app.workspace.openLinkText(linkText, sourcePath, false);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async getOrCreateMistakeFile(date, plan = []) {
    await this.ensureMistakeFolder();
    const path = buildMistakePath(date);
    const existing = this.app.vault.getFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      const synced = ensureMistakePlanSections(current, date, plan);
      if (synced !== current) {
        await this.app.vault.modify(existing, synced);
      }
      return existing;
    }
    return this.app.vault.create(path, renderMistakeMarkdown(date, plan));
  }

  async ensureDiaryFolder() {
    if (!this.app.vault.getAbstractFileByPath(DIARY_FOLDER)) {
      await this.app.vault.createFolder(DIARY_FOLDER);
    }
  }

  async ensureMistakeFolder() {
    if (!this.app.vault.getAbstractFileByPath(MISTAKE_FOLDER)) {
      await this.app.vault.createFolder(MISTAKE_FOLDER);
    }
  }

  async loadFile(file) {
    this.currentFile = file;
    const text = await this.app.vault.read(file);
    this.lastWrittenText = text;
    this.data = parseDailyMarkdown(text, dateFromPath(file.path) || formatDate(new Date()));
    this.render();
  }

  getRootEl() {
    if (this.contentEl) return this.contentEl;
    if (this.containerEl && this.containerEl.children) return this.containerEl.children[1];
    return null;
  }

  render() {
    const container = this.getRootEl();
    if (!container) return;
    container.empty();
    container.addClass("csd-root");

    if (!this.data || !this.currentFile) {
      container.createDiv({ cls: "csd-empty", text: "正在加载考公工作台..." });
      return;
    }

    this.renderBanner(container);
    const shell = container.createDiv({ cls: "csd-shell" });
    this.renderSidebar(shell.createDiv({ cls: "csd-sidebar" }));
    this.renderCards(shell.createDiv({ cls: "csd-content" }));
  }

  renderBanner(container) {
    const metrics = calculateCompletion(this.data.plan);
    const practiceSummary = calculatePracticeSummary(this.data.practice.items);
    const banner = container.createDiv({ cls: "csd-banner" });
    const copy = banner.createDiv({ cls: "csd-banner-copy" });
    copy.createEl("p", { cls: "csd-kicker", text: "Civil Service Dashboard" });
    copy.createEl("h2", { text: `${this.data.date} 考公工作台` });
    copy.createEl("p", {
      cls: "csd-banner-subtitle",
      text: "把今天的计划、做题和复盘压到同一张桌面上。",
    });

    const stats = banner.createDiv({ cls: "csd-banner-stats" });
    stats.createDiv({ cls: "csd-stat", text: `计划 ${metrics.done}/${metrics.total}` });
    stats.createDiv({ cls: "csd-stat", text: `完成率 ${metrics.percent}%` });
    stats.createDiv({ cls: "csd-stat", text: `行测正确率 ${practiceSummary.accuracy}` });
    const progress = banner.createDiv({ cls: "csd-progress" });
    progress.createDiv({ cls: "csd-progress-fill" }).style.width = `${metrics.percent}%`;
  }

  renderSidebar(sidebar) {
    const actionPanel = sidebar.createDiv({ cls: "csd-panel csd-actions" });
    actionPanel.createEl("h3", { text: "快捷操作" });

    const todayButton = actionPanel.createEl("button", { cls: "csd-action-button" });
    setIcon(todayButton.createSpan({ cls: "csd-action-icon" }), "calendar-plus");
    todayButton.createSpan({ text: "创建/切换今日记录" });
    todayButton.addEventListener("click", () => this.switchToToday());

    const openButton = actionPanel.createEl("button", { cls: "csd-action-button" });
    setIcon(openButton.createSpan({ cls: "csd-action-icon" }), "file-text");
    openButton.createSpan({ text: "打开当前 Markdown" });
    openButton.addEventListener("click", () => this.openCurrentFile());

    const current = sidebar.createDiv({ cls: "csd-panel" });
    current.createEl("h3", { text: "当前记录" });
    current.createDiv({ cls: "csd-current-date", text: this.data.date });
    current.createDiv({ cls: "csd-current-path", text: this.currentFile.path });

    const recent = sidebar.createDiv({ cls: "csd-panel csd-recent" });
    recent.createEl("h3", { text: "最近日期" });
    recent.createDiv({ cls: "csd-date-list" });
    this.renderDateList();
  }

  renderDateList() {
    const root = this.getRootEl();
    const list = root ? root.querySelector(".csd-date-list") : null;
    if (!list) return;
    list.empty();

    const dailyFiles = this.getDailyFiles();
    if (dailyFiles.length === 0) {
      list.createDiv({ cls: "csd-muted", text: "暂无日期记录" });
      return;
    }

    for (const file of dailyFiles.slice(0, 8)) {
      const date = dateFromPath(file.path) || file.basename;
      const button = list.createEl("button", {
        cls: `csd-date-item${this.currentFile && file.path === this.currentFile.path ? " is-active" : ""}`,
      });
      button.createSpan({ text: date });
      button.addEventListener("click", () => this.loadFile(file));
    }
  }

  renderCards(content) {
    this.renderPlanCard(content.createDiv({ cls: "csd-card csd-plan-card" }));
    this.renderPracticeCard(content.createDiv({ cls: "csd-card csd-practice-card" }));
    this.renderReviewCard(content.createDiv({ cls: "csd-card csd-review-card" }));
  }

  renderPlanCard(card) {
    this.renderCardHeader(card, "本日计划", "check-square");
    const list = card.createDiv({ cls: "csd-task-list" });

    this.data.plan.forEach((task, index) => {
      const row = list.createDiv({ cls: "csd-task-row" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = task.checked;
      checkbox.addEventListener("change", () => {
        this.data.plan[index].checked = checkbox.checked;
        row.toggleClass("is-done", checkbox.checked);
        this.updateHeaderMetrics();
        this.scheduleSave();
      });

      const input = row.createEl("input", {
        cls: "csd-task-input",
        attr: { type: "text", placeholder: "输入今日计划..." },
      });
      input.value = task.text;
      input.addEventListener("input", () => {
        this.data.plan[index].text = input.value;
        this.data.practice.items = syncPracticeItems(this.data.plan, this.data.practice.items);
        this.scheduleSave();
      });

      const mistake = row.createEl("button", {
        cls: "csd-plan-mistake-button",
        text: "错题",
        attr: { "aria-label": `打开${task.text || "当前计划"}错题` },
      });
      mistake.addEventListener("click", () => this.openPlanMistakeNote(index));

      const remove = row.createEl("button", {
        cls: "csd-icon-button csd-delete-button",
        text: "×",
        attr: { "aria-label": "删除计划" },
      });
      remove.addEventListener("click", () => {
        this.data.plan.splice(index, 1);
        if (Array.isArray(this.data.practice.items)) {
          this.data.practice.items.splice(index, 1);
        }
        this.data.practice.items = syncPracticeItems(this.data.plan, this.data.practice.items);
        this.render();
        this.scheduleSave();
      });

      row.toggleClass("is-done", task.checked);
    });

    const addRow = card.createDiv({ cls: "csd-add-row" });
    const addInput = addRow.createEl("input", {
      cls: "csd-text-input",
      attr: { type: "text", placeholder: "新增计划，例如：资料分析 20 题" },
    });
    const addButton = addRow.createEl("button", { cls: "csd-primary-button", text: "添加" });
    const addTask = () => {
      const text = addInput.value.trim();
      if (!text) return;
      this.data.plan.push({ text, checked: false });
      this.data.practice.items = syncPracticeItems(this.data.plan, this.data.practice.items);
      this.render();
      this.scheduleSave();
    };
    addButton.addEventListener("click", addTask);
    addInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTask();
    });
  }

  renderPracticeCard(card) {
    this.renderCardHeader(card, "本日做题情况", "bar-chart-3");
    this.data.practice.items = syncPracticeItems(this.data.plan, this.data.practice.items);
    const list = card.createDiv({ cls: "csd-practice-list" });

    this.data.practice.items.forEach((item, index) => {
      const row = list.createDiv({ cls: "csd-practice-row" });
      row.createDiv({ cls: "csd-practice-title", text: item.text || "未命名计划" });

      const totalField = row.createDiv({ cls: "csd-practice-field" });
      totalField.createEl("label", { text: "总题数" });
      const totalInput = totalField.createEl("input", {
        cls: "csd-text-input csd-practice-total-input",
        attr: { type: "number", placeholder: "0" },
      });
      totalInput.value = item.total || "";

      const correctField = row.createDiv({ cls: "csd-practice-field" });
      correctField.createEl("label", { text: "正确数" });
      const correctInput = correctField.createEl("input", {
        cls: "csd-text-input csd-practice-correct-input",
        attr: { type: "number", placeholder: "0" },
      });
      correctInput.value = item.correct || "";

      const accuracyField = row.createDiv({ cls: "csd-practice-field" });
      accuracyField.createEl("label", { text: "正确率" });
      const accuracyValue = accuracyField.createDiv({
        cls: "csd-readonly-value csd-practice-accuracy-value",
        text: item.accuracy || "0%",
      });

      const durationField = row.createDiv({ cls: "csd-practice-field" });
      durationField.createEl("label", { text: "用时" });
      const durationInput = durationField.createEl("input", {
        cls: "csd-text-input csd-practice-duration-input",
        attr: { type: "text", placeholder: "25m" },
      });
      durationInput.value = item.duration || "";

      const mistakeField = row.createDiv({ cls: "csd-practice-field csd-practice-mistake-field" });
      mistakeField.createEl("label", { text: "错题" });
      const mistakeButton = mistakeField.createEl("button", {
        cls: "csd-primary-button csd-practice-mistake-button",
        text: "错题",
      });
      mistakeButton.addEventListener("click", () => this.openPlanMistakeNote(index));

      const updateItem = () => {
        const total = totalInput.value;
        const correct = correctInput.value;
        const duration = durationInput.value;
        this.data.practice.items[index] = {
          text: stringValue(this.data.plan[index] && this.data.plan[index].text),
          total,
          correct,
          accuracy: calculateAccuracy(total, correct),
          duration,
        };
        accuracyValue.setText(this.data.practice.items[index].accuracy);
        this.updateHeaderMetrics();
        this.scheduleSave();
      };
      totalInput.addEventListener("input", updateItem);
      correctInput.addEventListener("input", updateItem);
      durationInput.addEventListener("input", updateItem);
    });

    const actions = card.createDiv({ cls: "csd-practice-actions" });
    const mistakeButton = actions.createEl("button", {
      cls: "csd-primary-button csd-mistake-button",
      text: "创建/打开错题本",
    });
    mistakeButton.addEventListener("click", async () => {
      await this.openDailyMistakeNote();
    });
  }

  renderReviewCard(card) {
    this.renderCardHeader(card, "复盘", "book-open-check");
    const textarea = card.createEl("textarea", {
      cls: "csd-review-textarea",
      attr: { placeholder: "记录今天的主要问题、有效方法、明天要修正的动作..." },
    });
    textarea.value = this.data.review || "";
    textarea.addEventListener("input", () => {
      this.data.review = textarea.value;
      this.scheduleSave();
    });
  }

  renderCardHeader(card, title, icon) {
    const header = card.createDiv({ cls: "csd-card-header" });
    const iconWrap = header.createSpan({ cls: "csd-card-icon" });
    setIcon(iconWrap, icon);
    header.createEl("h3", { text: title });
  }

  renderField(parent, label, key, type, placeholder) {
    const field = parent.createDiv({ cls: "csd-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", {
      cls: "csd-text-input",
      attr: { type, placeholder },
    });
    input.value = this.data.practice[key] || "";
    input.addEventListener("input", () => {
      this.data.practice[key] = input.value;
      this.scheduleSave();
    });
    return input;
  }

  updateHeaderMetrics() {
    if (!this.data) return;
    this.data.practice.items = syncPracticeItems(this.data.plan, this.data.practice.items);
    const practiceSummary = calculatePracticeSummary(this.data.practice.items);

    const metrics = calculateCompletion(this.data.plan);
    const root = this.getRootEl();
    if (!root) return;
    const stats = root.querySelectorAll(".csd-stat");
    if (stats[0]) stats[0].setText(`计划 ${metrics.done}/${metrics.total}`);
    if (stats[1]) stats[1].setText(`完成率 ${metrics.percent}%`);
    if (stats[2]) stats[2].setText(`行测正确率 ${practiceSummary.accuracy}`);

    const fill = root.querySelector(".csd-progress-fill");
    if (fill) fill.style.width = `${metrics.percent}%`;
  }

  async openCurrentFile() {
    if (!this.currentFile) return;
    await this.app.workspace.getLeaf(false).openFile(this.currentFile);
  }

  getDailyFiles() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${DIARY_FOLDER}/`) && dateFromPath(file.path))
      .sort((a, b) => b.basename.localeCompare(a.basename));
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  async saveNow() {
    if (!this.currentFile || !this.data) return;
    const markdown = renderDailyMarkdown(this.data);
    this.lastWrittenText = markdown;
    await this.app.vault.modify(this.currentFile, markdown);
  }
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromPath(path) {
  const match = path.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : "";
}

module.exports = CivilServiceDashboardPlugin;
