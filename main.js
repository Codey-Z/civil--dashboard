const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, setIcon } = require("obsidian");

const VIEW_TYPE = "civil-service-dashboard-view";
const DIARY_FOLDER = "日记";
const MISTAKE_FOLDER = "错题";
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DEFAULT_PLAN_TEMPLATE = [
  "资料分析第 1 套",
  "资料分析第 2 套",
  "言语理解第 1 套",
];
const MISTAKE_TAXONOMY = {
  "资料分析": ["读题偏差", "主体看错", "时间看错", "指标看错", "公式选错", "单位换算", "计算失误", "估算不当", "比较方法不当", "速度取舍"],
  "言语理解": ["主题句误判", "转折递进忽略", "语境理解偏差", "选项偷换概念", "感情色彩误判", "逻辑关系误判", "关键词遗漏", "过度推断", "干扰项排除不足", "速度取舍"],
  "判断推理": ["规律入口错误", "图形细节遗漏", "条件翻译错误", "逻辑关系误判", "定义关键词遗漏", "类比关系误判", "排除法不足", "假设代入不当", "信息整理混乱", "时间取舍"],
  "数量关系": ["题型识别错误", "方程设错", "代入排除不足", "枚举遗漏", "比例倍数误用", "排列组合误判", "行程工程模型错", "计算失误", "跳题取舍", "时间分配"],
  "常识判断": ["知识盲区", "概念混淆", "时政不熟", "法律条文不熟", "历史地理不熟", "经济科技不熟", "关键词误读", "排除法不足", "常识反推错误", "印象判断"],
  "申论": ["审题偏差", "材料定位错误", "要点遗漏", "概括不准", "逻辑层次混乱", "表达不规范", "对策空泛", "关键词缺失", "字数控制", "时间分配"],
  "其他": ["读题", "方法", "速度", "知识", "计算", "表达", "心态", "取舍", "粗心", "未分类"],
};

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

function renderMistakeMarkdown(date, plan = [], practiceItems = []) {
  return ensureMistakePlanSections(renderMistakeBase(date), date, plan, practiceItems);
}

function ensureMistakePlanSections(markdown, date, plan = [], practiceItems = []) {
  const source = markdown || renderMistakeBase(date);
  const sections = buildMistakeSections(plan);
  const missingSections = sections.filter((section) => !hasHeading(source, section.title));
  let next = source;

  if (missingSections.length > 0) {
    const sectionText = missingSections
      .map((section) => renderMistakeSection(section.title, practiceItems[section.index]))
      .join("\n");
    const lines = next.split(/\r?\n/);
    const reviewIndex = lines.findIndex((line) => line.trim() === "## 回看");
    if (reviewIndex === -1) {
      next = `${next.replace(/\s*$/, "\n\n")}${sectionText}`;
    } else {
      const before = lines.slice(0, reviewIndex).join("\n").replace(/\s*$/, "");
      const after = lines.slice(reviewIndex).join("\n").replace(/^\s*/, "");
      next = `${before}\n\n${sectionText}\n${after}`.replace(/\s*$/, "\n");
    }
  }

  return fillMistakeReviewStats(next, sections, practiceItems);
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
  return normalizePlanTemplate(plan).map((text, index) => {
    const count = (counts.get(text) || 0) + 1;
    counts.set(text, count);
    return { index, title: count === 1 ? text : `${text}（${count}）` };
  });
}

function renderMistakeSection(title, practiceItem = {}) {
  const stats = buildMistakeReviewStats(practiceItem);
  return [
    `## ${title}`,
    "",
    `题型:: ${inferMistakeType(title)}`,
    "错因分类:: ",
    `总题数:: ${stats.total}`,
    `正确数:: ${stats.correct}`,
    `错题数:: ${stats.wrong}`,
    `正确率:: ${stats.accuracy}`,
    `用时:: ${stats.duration}`,
    "",
    "### 错因分布",
    "",
    "- 未分类：",
    "",
    "### 本套问题",
    "",
    "### 本套复盘",
    "",
    "",
  ].join("\n");
}

function inferMistakeType(title) {
  const text = stringValue(title);
  if (/资料/.test(text)) return "资料分析";
  if (/言语/.test(text)) return "言语理解";
  if (/判断|图推|图形|逻辑|定义|类比/.test(text)) return "判断推理";
  if (/数量/.test(text)) return "数量关系";
  if (/常识/.test(text)) return "常识判断";
  if (/申论/.test(text)) return "申论";
  return "其他";
}

function buildMistakeReviewStats(practiceItem = {}) {
  const total = stringValue(practiceItem.total);
  const correct = stringValue(practiceItem.correct);
  const wrong = total || correct ? String(Math.max(0, parseNumber(total) - parseNumber(correct))) : "";
  const accuracy = total || correct ? calculateAccuracy(total, correct) : "";
  return {
    total,
    correct,
    wrong,
    accuracy,
    duration: stringValue(practiceItem.duration),
  };
}

function fillMistakeReviewStats(markdown, sections, practiceItems = []) {
  const lines = String(markdown || "").split(/\r?\n/);
  let changed = false;

  for (const section of sections) {
    const range = findReviewBlockRangeByTitle(lines, section.title);
    if (!range) continue;
    const blockLines = lines.slice(range.start, range.end);
    if (!hasReviewStatsFields(blockLines)) continue;

    const stats = buildMistakeReviewStats(practiceItems[section.index]);
    for (let index = range.start; index < range.end; index += 1) {
      const replacement = fillBlankReviewField(lines[index], "总题数", stats.total)
        || fillBlankReviewField(lines[index], "正确数", stats.correct)
        || fillBlankReviewField(lines[index], "错题数", stats.wrong)
        || fillBlankReviewField(lines[index], "正确率", stats.accuracy)
        || fillBlankReviewField(lines[index], "用时", stats.duration);
      if (replacement && replacement !== lines[index]) {
        lines[index] = replacement;
        changed = true;
      }
    }
  }

  return changed ? lines.join("\n") : markdown;
}

function hasReviewStatsFields(lines) {
  return lines.some((line) => /^总题数::/.test(line.trim()))
    || lines.some((line) => /^正确数::/.test(line.trim()))
    || lines.some((line) => /^错题数::/.test(line.trim()))
    || lines.some((line) => /^正确率::/.test(line.trim()))
    || lines.some((line) => /^用时::/.test(line.trim()));
}

function fillBlankReviewField(line, fieldName, value) {
  if (!stringValue(value)) return "";
  const pattern = new RegExp(`^(${escapeRegex(fieldName)}::)\\s*$`);
  const match = stringValue(line).match(pattern);
  return match ? `${match[1]} ${value}` : "";
}

function normalizeMistakeTaxonomy(taxonomy) {
  const normalized = cloneMistakeTaxonomy(MISTAKE_TAXONOMY);
  if (!taxonomy || typeof taxonomy !== "object") return normalized;

  for (const [type, causes] of Object.entries(taxonomy)) {
    const cleanType = stringValue(type).trim();
    if (!cleanType) continue;
    const cleanCauses = normalizeCauseCategories(causes);
    if (cleanCauses.length > 0) {
      normalized[cleanType] = cleanCauses;
    }
  }
  return normalized;
}

function parseMistakeTaxonomyText(text) {
  const taxonomy = {};
  for (const line of stringValue(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/);
    if (!match) continue;
    const type = match[1].trim();
    const causes = normalizeCauseCategories(match[2]);
    if (type && causes.length > 0) {
      taxonomy[type] = causes;
    }
  }
  return taxonomy;
}

function serializeMistakeTaxonomy(taxonomy) {
  return Object.entries(normalizeMistakeTaxonomy(taxonomy))
    .map(([type, causes]) => `${type}：${causes.join("、")}`)
    .join("\n");
}

function getMistakeTypes(taxonomy = MISTAKE_TAXONOMY) {
  return Object.keys(normalizeMistakeTaxonomy(taxonomy));
}

function normalizeMistakeType(type, taxonomy = MISTAKE_TAXONOMY) {
  const value = stringValue(type).trim();
  return normalizeMistakeTaxonomy(taxonomy)[value] ? value : "其他";
}

function getMistakeCauseOptions(type, taxonomy = MISTAKE_TAXONOMY) {
  const normalized = normalizeMistakeTaxonomy(taxonomy);
  return [...normalized[normalizeMistakeType(type, normalized)]];
}

function parseMistakeReviewBlocks(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!sectionMatch || sectionMatch[1] === "回看") continue;
    const end = findNextReviewBoundary(lines, index + 1);
    const blockLines = lines.slice(index, end);
    blocks.push({
      title: sectionMatch[1],
      type: readDataviewField(blockLines, "题型"),
      causeCategories: splitCauseCategories(readDataviewField(blockLines, "错因分类")),
      total: readDataviewField(blockLines, "总题数"),
      correct: readDataviewField(blockLines, "正确数"),
      wrong: readDataviewField(blockLines, "错题数"),
      accuracy: readDataviewField(blockLines, "正确率"),
      duration: readDataviewField(blockLines, "用时"),
      causeDistribution: parseCauseDistribution(blockLines),
      setProblems: readReviewSubsection(blockLines, "本套问题")
        || readReviewSubsection(blockLines, "代表问题")
        || readReviewSubsection(blockLines, "代表错题"),
      setReview: readReviewSubsection(blockLines, "本套复盘")
        || combineReviewLines([
          readReviewConclusion(blockLines),
          readReviewSubsection(blockLines, "共性模式") || readReviewSubsection(blockLines, "共性问题"),
          readReviewSubsection(blockLines, "下次动作"),
        ]),
    });
  }
  return blocks;
}

function getMistakeReviewBlockAtLine(markdown, cursorLine) {
  const lines = String(markdown || "").split(/\r?\n/);
  const line = Math.max(0, Number(cursorLine) || 0);
  const range = findReviewBlockRange(lines, line);
  if (!range) return null;
  return parseMistakeReviewBlocks(lines.slice(range.start, range.end).join("\n"))[0] || null;
}

function updateMistakeReviewProperties(markdown, cursorLine, type, causeCategories = [], taxonomy = MISTAKE_TAXONOMY) {
  const source = String(markdown || "");
  const lines = source.split(/\r?\n/);
  const line = Math.max(0, Number(cursorLine) || 0);
  const range = findReviewBlockRange(lines, line);
  if (!range) {
    return { changed: false, markdown: source };
  }

  const selectedType = normalizeMistakeType(type, taxonomy);
  const selectedCauses = normalizeCauseCategories(causeCategories);
  let changed = false;
  let typeFound = false;

  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^题型::/.test(lines[index].trim())) {
      const nextLine = `题型:: ${selectedType}`;
      if (lines[index] !== nextLine) {
        lines[index] = nextLine;
        changed = true;
      }
      typeFound = true;
      break;
    }
  }
  if (!typeFound) {
    lines.splice(range.start + 1, 0, "", `题型:: ${selectedType}`);
    range.end += 2;
    changed = true;
  }

  if (selectedCauses.length > 0 && updateCauseCategoryField(lines, range, selectedCauses)) {
    changed = true;
  }

  const distribution = findOrCreateCauseDistribution(lines, range);
  const existingCauses = new Set(parseCauseDistribution(lines.slice(distribution.start, distribution.end)).map((item) => item.cause));
  const additions = selectedCauses.filter((cause) => !existingCauses.has(cause));
  if (additions.length > 0) {
    lines.splice(distribution.insertAt, 0, ...additions.map((cause) => `- ${cause}：`));
    changed = true;
  }

  return { changed, markdown: changed ? lines.join("\n") : source };
}

function updateMistakeReviewBlock(markdown, title, updates = {}, taxonomy = MISTAKE_TAXONOMY) {
  const source = String(markdown || "");
  const lines = source.split(/\r?\n/);
  const range = findReviewBlockRangeByTitle(lines, title);
  if (!range) {
    return { changed: false, markdown: source };
  }

  let changed = false;
  const setField = (fieldName, value) => {
    if (updateReviewDataviewField(lines, range, fieldName, value)) changed = true;
  };

  if (hasOwn(updates, "type")) {
    setField("题型", normalizeMistakeType(updates.type, taxonomy));
  }
  if (hasOwn(updates, "causeCategories")) {
    const selectedCauses = normalizeCauseCategories(updates.causeCategories);
    setField("错因分类", selectedCauses.join(", "));
    if (selectedCauses.length > 0) {
      const distribution = findOrCreateCauseDistribution(lines, range);
      const existingCauses = new Set(parseCauseDistribution(lines.slice(distribution.start, distribution.end)).map((item) => item.cause));
      const additions = selectedCauses.filter((cause) => !existingCauses.has(cause));
      if (additions.length > 0) {
        lines.splice(distribution.insertAt, 0, ...additions.map((cause) => `- ${cause}：`));
        range.end += additions.length;
        changed = true;
      }
    }
  }
  if (hasOwn(updates, "total")) setField("总题数", updates.total);
  if (hasOwn(updates, "correct")) setField("正确数", updates.correct);
  if (hasOwn(updates, "wrong")) setField("错题数", updates.wrong);
  if (hasOwn(updates, "accuracy")) setField("正确率", updates.accuracy);
  if (hasOwn(updates, "duration")) setField("用时", updates.duration);
  if (hasOwn(updates, "setProblems") && updateReviewSubsection(lines, range, "本套问题", updates.setProblems, ["代表问题", "代表错题"])) {
    changed = true;
  }
  if (hasOwn(updates, "representativeProblems") && updateReviewSubsection(lines, range, "本套问题", updates.representativeProblems, ["代表问题", "代表错题"])) {
    changed = true;
  }
  if (hasOwn(updates, "setReview") && updateReviewSubsection(lines, range, "本套复盘", updates.setReview)) {
    changed = true;
  }

  return { changed, markdown: changed ? lines.join("\n") : source };
}

function updateCauseCategoryField(lines, range, selectedCauses) {
  const nextLine = `错因分类:: ${selectedCauses.join(", ")}`;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^错因分类::/.test(lines[index].trim())) {
      if (lines[index] === nextLine) return false;
      lines[index] = nextLine;
      return true;
    }
  }

  let insertAt = range.start + 1;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^题型::/.test(lines[index].trim())) {
      insertAt = index + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, nextLine);
  range.end += 1;
  return true;
}

function findReviewBlockRange(lines, cursorLine) {
  let start = -1;
  for (let index = Math.min(cursorLine, lines.length - 1); index >= 0; index -= 1) {
    const heading = lines[index].trim().match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (heading[1] === "回看") return null;
      start = index;
      break;
    }
    if (/^#\s+/.test(lines[index].trim())) break;
  }
  if (start === -1) return null;

  const end = findNextReviewBoundary(lines, start + 1);
  if (cursorLine < start || cursorLine >= end) return null;
  return { start, end };
}

function findReviewBlockRangeByTitle(lines, title) {
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) return null;
  return { start, end: findNextReviewBoundary(lines, start + 1) };
}

function findNextReviewBoundary(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) return index;
  }
  return lines.length;
}

function readDataviewField(lines, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}::\\s*(.*)$`);
  const line = lines.find((blockLine) => pattern.test(blockLine.trim()));
  return line ? line.trim().match(pattern)[1].trim() : "";
}

function readReviewConclusion(lines) {
  const line = lines.find((blockLine) => /^>\s*一句话结论：/.test(blockLine.trim()));
  const match = line ? line.trim().match(/^>\s*一句话结论：\s*(.*)$/) : null;
  return match ? match[1].trim() : "";
}

function readReviewSubsection(lines, heading) {
  const headingIndex = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (headingIndex === -1) return "";
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^###\s+/.test(lines[index].trim()) || /^##\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return trimOuterBlankLines(lines.slice(headingIndex + 1, end)).join("\n");
}

function combineReviewLines(values) {
  return values
    .map((value) => stringValue(value).trim())
    .filter(Boolean)
    .join("\n\n");
}

function updateReviewDataviewField(lines, range, fieldName, value) {
  const nextLine = `${fieldName}:: ${stringValue(value).trim()}`;
  const pattern = new RegExp(`^${escapeRegex(fieldName)}::`);
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (pattern.test(lines[index].trim())) {
      if (lines[index] === nextLine) return false;
      lines[index] = nextLine;
      return true;
    }
  }

  const insertAt = findReviewFieldInsertIndex(lines, range);
  lines.splice(insertAt, 0, nextLine);
  range.end += 1;
  return true;
}

function findReviewFieldInsertIndex(lines, range) {
  let insertAt = range.start + 1;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) break;
    if (/^\S+::/.test(lines[index].trim())) insertAt = index + 1;
  }
  return insertAt;
}

function updateReviewConclusion(lines, range, value) {
  const nextLine = `> 一句话结论：${stringValue(value).trim()}`;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^>\s*一句话结论：/.test(lines[index].trim())) {
      if (lines[index] === nextLine) return false;
      lines[index] = nextLine;
      return true;
    }
  }

  const insertAt = findReviewBodyInsertIndex(lines, range);
  lines.splice(insertAt, 0, "", nextLine);
  range.end += 2;
  return true;
}

function updateReviewSubsection(lines, range, heading, value, aliases = []) {
  let headingIndex = -1;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index].trim();
    const acceptedHeadings = [heading, ...aliases].map((item) => `### ${item}`);
    if (acceptedHeadings.includes(line)) {
      headingIndex = index;
      if (line !== `### ${heading}`) {
        lines[index] = `### ${heading}`;
      }
      break;
    }
  }

  const contentLines = trimOuterBlankLines(stringValue(value).split(/\r?\n/));
  const bodyLines = contentLines.length > 0 ? ["", ...contentLines, ""] : [""];
  if (headingIndex === -1) {
    lines.splice(range.end, 0, "", `### ${heading}`, ...bodyLines);
    range.end += 2 + bodyLines.length;
    return true;
  }

  let end = range.end;
  for (let index = headingIndex + 1; index < range.end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  const current = lines.slice(headingIndex + 1, end);
  if (arraysEqual(current, bodyLines)) return false;
  lines.splice(headingIndex + 1, end - headingIndex - 1, ...bodyLines);
  range.end += bodyLines.length - current.length;
  return true;
}

function findReviewBodyInsertIndex(lines, range) {
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) return index;
  }
  return range.end;
}

function findOrCreateCauseDistribution(lines, range) {
  let headingIndex = -1;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (lines[index].trim() === "### 错因分布") {
      headingIndex = index;
      break;
    }
  }
  if (headingIndex === -1) {
    lines.splice(range.end, 0, "", "### 错因分布", "", "- 未分类：");
    headingIndex = range.end + 1;
    range.end += 4;
  }

  let end = range.end;
  for (let index = headingIndex + 1; index < range.end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") {
    insertAt -= 1;
  }
  return { start: headingIndex, end, insertAt };
}

function parseCauseDistribution(lines) {
  const headingIndex = lines.findIndex((line) => line.trim() === "### 错因分布");
  if (headingIndex === -1) return [];
  const distribution = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^###\s+/.test(line)) break;
    const match = line.match(/^-+\s*(.+?)：\s*(.*?)\s*$/);
    if (match) {
      distribution.push({ cause: match[1].trim(), count: match[2].trim() });
    }
  }
  return distribution;
}

function splitCauseCategories(value) {
  return stringValue(value)
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCauseCategories(causeCategories) {
  const source = Array.isArray(causeCategories) ? causeCategories : splitCauseCategories(causeCategories);
  return [...new Set(source.map((item) => stringValue(item).trim()).filter(Boolean))];
}

function cloneMistakeTaxonomy(taxonomy) {
  return Object.fromEntries(
    Object.entries(taxonomy || {}).map(([type, causes]) => [type, normalizeCauseCategories(causes)])
  );
}

function trimOuterBlankLines(lines) {
  const next = [...lines];
  while (next.length && !next[0].trim()) next.shift();
  while (next.length && !next[next.length - 1].trim()) next.pop();
  return next;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

function getReviewInitialCauses(block) {
  const categories = Array.isArray(block && block.causeCategories) ? block.causeCategories : [];
  if (categories.length) return categories;
  return Array.isArray(block && block.causeDistribution) ? block.causeDistribution.map((item) => item.cause) : [];
}

function findReviewHeadingLine(markdown, title) {
  const target = `## ${stringValue(title).trim()}`;
  return String(markdown || "").split(/\r?\n/).findIndex((line) => line.trim() === target);
}

function createChildEl(parent, tag, options = {}) {
  if (parent && typeof parent.createEl === "function") {
    return parent.createEl(tag, options);
  }
  if (!parent || !parent.ownerDocument || typeof parent.appendChild !== "function") {
    return null;
  }
  const element = parent.ownerDocument.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr || {})) {
    element.setAttribute(key, value);
  }
  parent.appendChild(element);
  return element;
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

    this.addCommand({
      id: "set-current-review-properties",
      name: "错题本：设置当前复盘属性",
      editorCallback: (editor) => this.openReviewPropertyModal(editor),
    });

    this.registerMistakeReviewPostProcessor();

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      const block = getMistakeReviewBlockAtLine(
        typeof editor.getValue === "function" ? editor.getValue() : "",
        typeof editor.getCursor === "function" ? editor.getCursor().line : 0
      );
      if (!block) return;

      menu.addItem((item) => {
        item
          .setTitle("设置当前复盘属性")
          .setIcon("tags")
          .onClick(() => this.openReviewPropertyModal(editor));
      });
    }));
  }

  registerMistakeReviewPostProcessor() {
    if (typeof this.registerMarkdownPostProcessor !== "function") return;
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.decorateMistakeReviewHeadings(el, ctx);
    });
  }

  decorateMistakeReviewHeadings(el, ctx) {
    const sourcePath = ctx && ctx.sourcePath;
    if (!sourcePath || !sourcePath.startsWith(`${MISTAKE_FOLDER}/`) || !sourcePath.endsWith(".md")) {
      return;
    }

    const headings = typeof el.querySelectorAll === "function" ? Array.from(el.querySelectorAll("h2")) : [];
    for (const heading of headings) {
      const title = stringValue(heading.textContent || heading.text).trim();
      if (!title || title === "回看") continue;
      if (typeof heading.querySelector === "function" && heading.querySelector(".csd-review-property-button")) continue;

      const button = createChildEl(heading, "button", {
        cls: "csd-review-property-button",
        text: "属性",
        attr: {
          type: "button",
          title: "设置复盘属性",
        },
      });
      if (!button) continue;
      button.addEventListener("click", async (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        await this.openReviewPropertyModalForFile(sourcePath, title);
      });
    }
  }

  async openReviewPropertyModalForFile(sourcePath, title) {
    const file = this.app.vault.getFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到当前错题本文件");
      return;
    }

    const markdown = await this.app.vault.read(file);
    const line = findReviewHeadingLine(markdown, title);
    const block = line >= 0 ? getMistakeReviewBlockAtLine(markdown, line + 1) : null;
    if (!block) {
      new Notice("请先在错题本的 ## 计划复盘内设置属性");
      return;
    }

    new MistakePropertyModal(this.app, {
      taxonomy: this.getMistakeTaxonomy(),
      initialType: block.type,
      initialCauses: getReviewInitialCauses(block),
      onSubmit: async ({ type, causeCategories }) => {
        const currentMarkdown = await this.app.vault.read(file);
        const currentLine = findReviewHeadingLine(currentMarkdown, title);
        const updated = updateMistakeReviewProperties(currentMarkdown, currentLine + 1, type, causeCategories, this.getMistakeTaxonomy());
        if (!updated.changed) {
          new Notice("请先在错题本的 ## 计划复盘内设置属性");
          return;
        }
        await this.app.vault.modify(file, updated.markdown);
        new Notice("已更新当前复盘属性");
      },
    }).open();
  }

  async loadSettings() {
    const data = await this.loadData();
    return {
      planTemplate: normalizePlanTemplate(data && data.planTemplate),
      mistakeTaxonomy: normalizeMistakeTaxonomy(data && data.mistakeTaxonomy),
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

  getMistakeTaxonomy() {
    return normalizeMistakeTaxonomy(this.settings && this.settings.mistakeTaxonomy);
  }

  getMistakeTaxonomyText() {
    return serializeMistakeTaxonomy(this.getMistakeTaxonomy());
  }

  async setMistakeTaxonomyFromText(text) {
    this.settings = {
      ...this.settings,
      mistakeTaxonomy: normalizeMistakeTaxonomy(parseMistakeTaxonomyText(text)),
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

  openReviewPropertyModal(editor) {
    const markdown = typeof editor.getValue === "function" ? editor.getValue() : "";
    const cursor = typeof editor.getCursor === "function" ? editor.getCursor() : { line: 0 };
    const block = getMistakeReviewBlockAtLine(markdown, cursor.line);
    if (!block) {
      new Notice("请先把光标放在某个 ## 计划复盘内");
      return;
    }

    new MistakePropertyModal(this.app, {
      taxonomy: this.getMistakeTaxonomy(),
      initialType: block.type,
      initialCauses: getReviewInitialCauses(block),
      onSubmit: ({ type, causeCategories }) => {
        const currentMarkdown = typeof editor.getValue === "function" ? editor.getValue() : markdown;
        const currentCursor = typeof editor.getCursor === "function" ? editor.getCursor() : cursor;
        const updated = updateMistakeReviewProperties(currentMarkdown, currentCursor.line, type, causeCategories, this.getMistakeTaxonomy());
        if (!updated.changed) {
          new Notice("请先把光标放在某个 ## 计划复盘内");
          return;
        }
        if (typeof editor.setValue === "function") editor.setValue(updated.markdown);
        if (typeof editor.setCursor === "function") editor.setCursor(currentCursor);
        new Notice("已更新当前复盘属性");
      },
    }).open();
  }
}

class MistakePropertyModal extends Modal {
  constructor(app, options) {
    super(app);
    this.taxonomy = normalizeMistakeTaxonomy(options.taxonomy);
    this.initialType = normalizeMistakeType(options.initialType, this.taxonomy);
    this.selectedType = this.initialType === "其他" && !options.initialType ? "资料分析" : this.initialType;
    this.selectedCauses = new Set(options.initialCauses || []);
    this.onSubmitSelection = options.onSubmit;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csd-mistake-property-modal");
    contentEl.createEl("h2", { text: "设置当前复盘属性" });

    const typeSection = contentEl.createDiv({ cls: "csd-mistake-property-section" });
    typeSection.createDiv({ cls: "csd-mistake-property-label", text: "题型" });
    const typeList = typeSection.createDiv({ cls: "csd-mistake-option-list" });
    for (const type of getMistakeTypes(this.taxonomy)) {
      const button = typeList.createEl("button", {
        cls: "csd-mistake-type-option",
        text: type,
      });
      button.toggleClass("is-selected", type === this.selectedType);
      button.addEventListener("click", () => {
        if (type !== this.selectedType) {
          this.selectedType = type;
          this.selectedCauses = new Set();
          this.render();
        }
      });
    }

    const causeSection = contentEl.createDiv({ cls: "csd-mistake-property-section" });
    causeSection.createDiv({ cls: "csd-mistake-property-label", text: "错因分类" });
    const causeList = causeSection.createDiv({ cls: "csd-mistake-option-list" });
    for (const cause of getMistakeCauseOptions(this.selectedType, this.taxonomy)) {
      const button = causeList.createEl("button", {
        cls: "csd-mistake-cause-option",
        text: cause,
      });
      button.toggleClass("is-selected", this.selectedCauses.has(cause));
      button.addEventListener("click", () => {
        if (this.selectedCauses.has(cause)) {
          this.selectedCauses.delete(cause);
        } else {
          this.selectedCauses.add(cause);
        }
        button.toggleClass("is-selected", this.selectedCauses.has(cause));
      });
    }

    const actions = contentEl.createDiv({ cls: "csd-mistake-property-actions" });
    const submit = actions.createEl("button", {
      cls: "csd-primary-button csd-mistake-property-submit",
      text: "写入当前复盘",
    });
    submit.addEventListener("click", () => {
      this.onSubmitSelection({
        type: this.selectedType,
        causeCategories: [...this.selectedCauses],
      });
      this.close();
    });
    const cancel = actions.createEl("button", {
      cls: "csd-secondary-button",
      text: "取消",
    });
    cancel.addEventListener("click", () => this.close());
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

    new Setting(containerEl)
      .setName("错因分类")
      .setDesc("一行一个题型，格式：题型：错因1、错因2、错因3。工作台复盘卡片和错题本属性弹窗会读取这里。")
      .addTextArea((text) => {
        text
          .setPlaceholder("资料分析：读题偏差、计算失误、估算不当")
          .setValue(this.plugin.getMistakeTaxonomyText())
          .onChange(async (value) => {
            await this.plugin.setMistakeTaxonomyFromText(value);
          });
        text.inputEl.rows = 12;
        text.inputEl.cols = 42;
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
    this.selectedReviewIndex = 0;
    this.mistakeReviewLoadId = 0;
    this.mistakeReviewLoadPromise = Promise.resolve();
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
    const file = await this.getOrCreateMistakeFile(date, this.data.plan, this.data.practice.items);
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

    const file = await this.getOrCreateMistakeFile(date, this.data.plan, this.data.practice.items);
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

  async getOrCreateMistakeFile(date, plan = [], practiceItems = []) {
    await this.ensureMistakeFolder();
    const path = buildMistakePath(date);
    const existing = this.app.vault.getFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      const synced = ensureMistakePlanSections(current, date, plan, practiceItems);
      if (synced !== current) {
        await this.app.vault.modify(existing, synced);
      }
      return existing;
    }
    return this.app.vault.create(path, renderMistakeMarkdown(date, plan, practiceItems));
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
    this.selectedReviewIndex = 0;
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
    this.renderMistakeReviewCard(content.createDiv({ cls: "csd-card csd-mistake-review-card" }));
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
        this.selectedReviewIndex = Math.min(this.selectedReviewIndex, Math.max(0, this.data.plan.length - 1));
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
      this.selectedReviewIndex = this.data.plan.length - 1;
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

  renderMistakeReviewCard(card) {
    this.renderCardHeader(card, "错题复盘卡片", "clipboard-check");
    const sections = buildMistakeSections(this.data.plan);
    if (sections.length === 0) {
      card.createDiv({ cls: "csd-muted", text: "先添加一个本日计划，再填写对应的错题复盘。" });
      this.mistakeReviewLoadPromise = Promise.resolve();
      return;
    }

    this.selectedReviewIndex = Math.min(Math.max(0, this.selectedReviewIndex), sections.length - 1);
    const selector = card.createDiv({ cls: "csd-mistake-review-selector" });
    sections.forEach((section, index) => {
      const button = selector.createEl("button", {
        cls: `csd-review-selector-button${index === this.selectedReviewIndex ? " is-active" : ""}`,
        text: section.title,
      });
      button.addEventListener("click", () => {
        this.selectedReviewIndex = index;
        this.render();
      });
    });

    const body = card.createDiv({ cls: "csd-mistake-review-body" });
    body.createDiv({ cls: "csd-muted", text: "正在加载复盘卡片..." });
    const loadId = this.mistakeReviewLoadId + 1;
    this.mistakeReviewLoadId = loadId;
    this.mistakeReviewLoadPromise = this.loadMistakeReviewBlock(this.selectedReviewIndex)
      .then(({ section, block }) => {
        if (loadId !== this.mistakeReviewLoadId) return;
        body.empty();
        this.renderMistakeReviewEditor(body, this.selectedReviewIndex, section, block);
      })
      .catch(() => {
        if (loadId !== this.mistakeReviewLoadId) return;
        body.empty();
        body.createDiv({ cls: "csd-muted", text: "复盘卡片加载失败，可以先打开错题本 Markdown 编辑。" });
      });
  }

  async loadMistakeReviewBlock(index) {
    const date = this.data.date || dateFromPath(this.currentFile.path) || formatDate(new Date());
    const sections = buildMistakeSections(this.data.plan);
    const section = sections[index];
    if (!section) return { section: null, block: null };

    const path = buildMistakePath(date);
    const existing = this.app.vault.getFileByPath(path);
    let markdown = "";
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      markdown = ensureMistakePlanSections(current, date, this.data.plan, this.data.practice.items);
      if (markdown !== current) {
        await this.app.vault.modify(existing, markdown);
      }
    } else {
      markdown = renderMistakeMarkdown(date, this.data.plan, this.data.practice.items);
    }

    const block = parseMistakeReviewBlocks(markdown).find((item) => item.title === section.title) || {};
    return { section, block };
  }

  renderMistakeReviewEditor(body, index, section, block = {}) {
    const titleRow = body.createDiv({ cls: "csd-mistake-review-title-row" });
    titleRow.createDiv({ cls: "csd-mistake-review-title", text: section.title });
    const openButton = titleRow.createEl("button", {
      cls: "csd-secondary-button csd-mistake-review-open-button",
      text: "打开 Markdown",
    });
    openButton.addEventListener("click", () => this.openPlanMistakeNote(index));

    const stats = body.createDiv({ cls: "csd-mistake-review-stats" });
    [
      ["总题数", block.total || ""],
      ["正确数", block.correct || ""],
      ["错题数", block.wrong || ""],
      ["正确率", block.accuracy || "0%"],
      ["用时", block.duration || ""],
    ].forEach(([label, value]) => {
      const item = stats.createDiv({ cls: "csd-mistake-review-stat" });
      item.createSpan({ text: label });
      item.createEl("strong", { text: value || "-" });
    });

    const meta = body.createDiv({ cls: "csd-mistake-review-meta" });
    const taxonomy = this.plugin.getMistakeTaxonomy();
    const typeField = meta.createDiv({ cls: "csd-mistake-review-field" });
    typeField.createEl("label", { text: "题型" });
    const typeSelect = typeField.createEl("select", { cls: "csd-text-input csd-mistake-review-type-select" });
    const currentType = normalizeMistakeType(block.type, taxonomy);
    getMistakeTypes(taxonomy).forEach((type) => {
      typeSelect.createEl("option", { text: type, attr: { value: type } });
    });
    typeSelect.value = currentType;
    typeSelect.addEventListener("change", async () => {
      await this.saveMistakeReviewUpdates(index, {
        type: typeSelect.value,
        causeCategories: [],
      });
      this.render();
    });

    const causeField = meta.createDiv({ cls: "csd-mistake-review-field csd-mistake-review-cause-field" });
    causeField.createEl("label", { text: "错因分类" });
    const causeList = causeField.createDiv({ cls: "csd-mistake-review-cause-list" });
    const selectedCauses = new Set(Array.isArray(block.causeCategories) ? block.causeCategories : []);
    getMistakeCauseOptions(currentType, taxonomy).forEach((cause) => {
      const chip = causeList.createEl("button", {
        cls: "csd-mistake-review-cause-chip",
        text: cause,
      });
      chip.toggleClass("is-selected", selectedCauses.has(cause));
      chip.addEventListener("click", async () => {
        if (selectedCauses.has(cause)) {
          selectedCauses.delete(cause);
        } else {
          selectedCauses.add(cause);
        }
        await this.saveMistakeReviewUpdates(index, {
          causeCategories: [...selectedCauses],
        });
        chip.toggleClass("is-selected", selectedCauses.has(cause));
      });
    });

    this.renderMistakeReviewTextarea(body, "本套问题", "csd-mistake-review-problems-input", block.setProblems, "setProblems", index, "这套题暴露出的主要问题，可以写题号，也可以直接写共性问题...");
    this.renderMistakeReviewTextarea(body, "本套复盘", "csd-mistake-review-set-review-input", block.setReview, "setReview", index, "这一套的共性问题、改进方法和下次动作...");
  }

  renderMistakeReviewTextarea(parent, label, className, value, updateKey, index, placeholder) {
    const field = parent.createDiv({ cls: "csd-mistake-review-field" });
    field.createEl("label", { text: label });
    const textarea = field.createEl("textarea", {
      cls: `csd-review-textarea csd-mistake-review-textarea ${className}`,
      attr: { placeholder },
    });
    textarea.value = value || "";
    textarea.addEventListener("input", async () => {
      await this.saveMistakeReviewUpdates(index, { [updateKey]: textarea.value });
    });
  }

  async saveMistakeReviewUpdates(index, updates) {
    if (!this.currentFile || !this.data) return;
    const date = this.data.date || dateFromPath(this.currentFile.path) || formatDate(new Date());
    const sections = buildMistakeSections(this.data.plan);
    const section = sections[index];
    if (!section) return;

    const file = await this.getOrCreateMistakeFile(date, this.data.plan, this.data.practice.items);
    const current = await this.app.vault.read(file);
    const updated = updateMistakeReviewBlock(current, section.title, updates, this.plugin.getMistakeTaxonomy());
    if (updated.changed) {
      await this.app.vault.modify(file, updated.markdown);
    }
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
