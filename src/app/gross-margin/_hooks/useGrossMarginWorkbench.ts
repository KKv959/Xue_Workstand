"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeedback } from "@/components/FeedbackProvider";
import { getGrossMarginAccountDisplayName, getGrossMarginAccountOptions } from "@/lib/gross-margin-account-names";
import { copyText } from "@/lib/copy-text";
import {
  bulkSaveGrossMarginMonitorRecords,
  getGrossMarginLibrary,
  resolveGrossMarginVideoAccount,
  saveGrossMarginMonitorRecord,
  saveGrossMarginPriceTable,
  saveGrossMarginReviewTemplate
} from "@/lib/client";
import {
  GROSS_MARGIN_SERVICE_CONFIGS,
  calculateGrossMargin,
  formatAmountInput,
  getActiveServiceOptions,
  makeDefaultSelections,
  makeEmptyQuantityInputs,
  makePriceInputs,
  parseGrossMarginAmount,
  toAbsoluteMetricValue,
  toAmount
} from "@/lib/gross-margin-calculator";
import { renderGrossMarginReviewTemplate } from "@/lib/gross-margin-template";
import { detectVideoPlatform, normalizeVideoUrlInput } from "@/lib/platform-links";
import type {
  GrossMarginLibrary,
  GrossMarginPriceTableSaveItem,
  GrossMarginServiceKind
} from "@/lib/types";
import {
  buildEngagementTarget,
  buildGrossMarginTemplateValues,
  buildImportedMaintenanceState,
  countTemplateLines,
  findGrossMarginAccount,
  formatPlatform,
  getGrossMarginAccountPrice,
  getPlatformReviewTemplate,
  normalizeTemplateText,
  type AccountPriceKind,
  type GrossMarginImportedTemplate,
  type PlatformKey
} from "../_lib/gross-margin-workbench-model";
import { useGrossMarginAccountRefresh } from "./useGrossMarginAccountRefresh";
import { useGrossMarginProjects } from "./useGrossMarginProjects";
import { chooseGrossMarginProjectOrder, findGrossMarginProjectOrders, getGrossMarginProjectPrices } from "@/lib/gross-margin-projects";

type BusyState = "" | "refresh" | "prices" | "price-editor" | "export" | "template" | "bulk-monitor";
type VideoAccountLookupState = {
  status: "idle" | "loading" | "matched" | "unmatched" | "error";
  message: string;
};

const pricePanelServiceConfigs = GROSS_MARGIN_SERVICE_CONFIGS.filter((config) => config.service !== "douPlus" && config.service !== "mustFire");

export function useGrossMarginWorkbench() {
  const { notify } = useFeedback();
  const [library, setLibrary] = useState<GrossMarginLibrary | null>(null);
  const libraryRef = useRef(library);
  const libraryLoaded = Boolean(library);
  useEffect(() => { libraryRef.current = library; }, [library]);
  useGrossMarginAccountRefresh(library, setLibrary);
  const [platform, setPlatform] = useState<PlatformKey>("douyin");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyState>("");
  const [accountName, setAccountName] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [resolvedVideo, setResolvedVideo] = useState<{ url: string; title: string; currentPlayCount: number | null } | null>(null);
  const currentVideo = resolvedVideo?.url === normalizeVideoUrlInput(videoUrl) ? resolvedVideo : null;
  const videoTitle = currentVideo?.title || "";
  const currentPlayCount = currentVideo?.currentPlayCount ?? null;
  const [originalPrice, setOriginalPrice] = useState("");
  const [accountPriceKind, setAccountPriceKind] = useState<AccountPriceKind>("custom");
  const [rebateRate, setRebateRate] = useState("");
  const [discountPrice, setDiscountPrice] = useState("");
  const [quantityInputs, setQuantityInputs] = useState<Record<GrossMarginServiceKind, string>>(
    makeEmptyQuantityInputs
  );
  const [selectedOptions, setSelectedOptions] = useState<Partial<Record<GrossMarginServiceKind, string>>>({});
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [bulkMonitorModalOpen, setBulkMonitorModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [priceEditorOpen, setPriceEditorOpen] = useState(false);
  const [splitDeliveryEnabled, setSplitDeliveryEnabled] = useState(false);
  const [videoAccountLookup, setVideoAccountLookup] = useState<VideoAccountLookupState>({
    status: "idle",
    message: ""
  });
  const accountNameRef = useRef("");
  const rebateRateRef = useRef("");
  const videoAccountLookupRequestRef = useRef(0);
  const projects = useGrossMarginProjects(libraryLoaded);
  const [projectSelection, setProjectSelection] = useState<{ context: string; id: string } | null>(null);
  const projectContext = `${platform}:${accountName}:${videoUrl}`;
  const projectSourceRef = useRef(projects.source);
  const projectSelectionRef = useRef(projectSelection);
  useEffect(() => { projectSourceRef.current = projects.source; projectSelectionRef.current = projectSelection; }, [projects.source, projectSelection]);
  const projectOrders = useMemo(() => findGrossMarginProjectOrders(projects.source?.orders || [], platform, accountName), [projects.source, platform, accountName]);
  const selectedProject = projectSelection?.context === projectContext
    ? projectOrders.find(order => order.id === projectSelection.id) || null
    : chooseGrossMarginProjectOrder(projectOrders, videoUrl);

  // 异步项目表到达或账号/链接切换后，带入选中记录的原始金额。
  useEffect(() => {
    if (!selectedProject) return;
    const prices = getGrossMarginProjectPrices(selectedProject);
    setOriginalPrice(prices.originalPrice);
    setRebateRate(prices.rebateRate);
    rebateRateRef.current = prices.rebateRate;
    setDiscountPrice(prices.discountPrice);
  }, [projectContext, selectedProject]);

  const tables = useMemo(() => library?.tables || [], [library]);
  const table = useMemo(
    () => tables.find((item) => item.platform === platform) || tables[0] || null,
    [platform, tables]
  );
  const reviewTemplate = useMemo(() => getPlatformReviewTemplate(library, platform), [library, platform]);
  const platformAccounts = useMemo(
    () => getGrossMarginAccountOptions((library?.accounts || []).filter((account) => account.platform === platform)),
    [library, platform]
  );
  const matchedAccount = useMemo(
    () => findGrossMarginAccount(platformAccounts, accountName),
    [accountName, platformAccounts]
  );
  const activeServiceConfigs = useMemo(
    () => GROSS_MARGIN_SERVICE_CONFIGS.filter((config) =>
      table ? getActiveServiceOptions(table, config.service).length > 0 : false
    ),
    [table]
  );
  const activePricePanelServiceConfigs = useMemo(
    () => pricePanelServiceConfigs.filter((config) =>
      table ? getActiveServiceOptions(table, config.service).length > 0 : false
    ),
    [table]
  );
  const calculation = useMemo(
    () => calculateGrossMargin({
      discountPrice,
      originalPrice,
      configs: activeServiceConfigs,
      priceInputs,
      quantityInputs,
      selectedOptions,
      table
    }),
    [activeServiceConfigs, discountPrice, originalPrice, priceInputs, quantityInputs, selectedOptions, table]
  );
  const validationError = calculation.errors?.[0] ||
    (parseGrossMarginAmount(rebateRate, 100) === null ? "返点比例必须在 0 到 100 之间" : "");
  const reviewTemplateValues = useMemo(
    () => buildGrossMarginTemplateValues({
      account: matchedAccount,
      accountName,
      calculation,
      currentPlayCount,
      platform,
      splitDeliveryEnabled,
      videoTitle,
      videoUrl
    }),
    [accountName, calculation, currentPlayCount, matchedAccount, platform, splitDeliveryEnabled, videoTitle, videoUrl]
  );
  const renderedReviewTemplate = useMemo(() => {
    try {
      return { text: renderGrossMarginReviewTemplate(reviewTemplate.content, reviewTemplateValues), error: "" };
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : "文案模板无法渲染" };
    }
  }, [reviewTemplate, reviewTemplateValues]);
  const effectiveReviewTemplate = renderedReviewTemplate.text;
  const reviewTemplateLineCount = countTemplateLines(effectiveReviewTemplate || reviewTemplate.content);
  const configuredPriceCount = table?.items.filter((item) =>
    toAmount(priceInputs[item.id] ?? item.unitPrice) > 0
  ).length || 0;
  const engagementTarget = useMemo(
    () => buildEngagementTarget(calculation.lines, videoUrl),
    [calculation.lines, videoUrl]
  );

  useEffect(() => {
    let ignore = false;
    getGrossMarginLibrary()
      .then((result) => {
        if (ignore) return;
        setLibrary(result);
        applyLibraryTable(result, "douyin");
      })
      .catch((error) => {
        if (!ignore) {
          notify({ tone: "error", message: error instanceof Error ? error.message : "读取毛利单价表失败" });
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [notify]);

  useEffect(() => {
    const nextUrl = normalizeVideoUrlInput(videoUrl);
    setResolvedVideo(null);
    if (!libraryLoaded || !nextUrl || !detectVideoPlatform(nextUrl)) {
      setVideoAccountLookup({ status: "idle", message: "" });
      return;
    }

    const requestId = videoAccountLookupRequestRef.current + 1;
    videoAccountLookupRequestRef.current = requestId;
    const accountNameBeforeLookup = accountNameRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setVideoAccountLookup({ status: "loading", message: "正在从视频链接识别账号…" });
      resolveGrossMarginVideoAccount(nextUrl, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted || videoAccountLookupRequestRef.current !== requestId) return;
          setResolvedVideo({ url: nextUrl, title: result.videoTitle, currentPlayCount: result.currentPlayCount });
          if (accountNameRef.current !== accountNameBeforeLookup) {
            setVideoAccountLookup({ status: "idle", message: "" });
            return;
          }

          const accounts = (libraryRef.current?.accounts || []).filter((account) => account.platform === result.platform);
          const resolvedAccount = findGrossMarginAccount(accounts, result.accountName);
          const resolvedName = getGrossMarginAccountDisplayName(resolvedAccount?.name || result.accountName);
          accountNameRef.current = resolvedName;
          setAccountName(resolvedName);
          const matchingProjects = findGrossMarginProjectOrders(projectSourceRef.current?.orders || [], result.platform, resolvedName);
          const selection = projectSelectionRef.current;
          const manuallySelected = selection?.context === `${result.platform}:${resolvedName}:${nextUrl}`;
          const resolvedProject = manuallySelected
            ? matchingProjects.find(order => order.id === selection.id)
            : chooseGrossMarginProjectOrder(matchingProjects, nextUrl);
          if (resolvedProject) {
            const prices = getGrossMarginProjectPrices(resolvedProject);
            setOriginalPrice(prices.originalPrice);
            setRebateRate(prices.rebateRate);
            rebateRateRef.current = prices.rebateRate;
            setDiscountPrice(prices.discountPrice);
          } else if (resolvedAccount && !manuallySelected) {
            const price = getGrossMarginAccountPrice(resolvedAccount, "custom");
            setAccountPriceKind(price.kind);
            setOriginalPrice(String(price.value));
            if (rebateRateRef.current.trim()) {
              setDiscountPrice(formatAmountInput(price.value * (1 - toAmount(rebateRateRef.current) / 100)));
            }
          }
          setVideoAccountLookup({
            status: resolvedAccount ? "matched" : "unmatched",
            message: resolvedAccount
              ? `已识别账号：${resolvedName}`
              : `已识别账号「${resolvedName}」，可选择当月项目或手动填写价格。`
          });
        })
        .catch((error) => {
          if (controller.signal.aborted || videoAccountLookupRequestRef.current !== requestId) return;
          setVideoAccountLookup({
            status: "error",
            message: error instanceof Error ? error.message : "视频账号识别失败，请手动填写账号名。"
          });
        });
    }, 500);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [libraryLoaded, videoUrl]);

  function applyLibraryTable(nextLibrary: GrossMarginLibrary, preferredPlatform: PlatformKey) {
    const nextTable = nextLibrary.tables.find((item) => item.platform === preferredPlatform) || nextLibrary.tables[0] || null;
    if (!nextTable) return;
    setPlatform(nextTable.platform);
    setPriceInputs(makePriceInputs(nextTable));
    setSelectedOptions(makeDefaultSelections(nextTable));
  }

  function handlePlatformChange(nextPlatform: PlatformKey) {
    clearProjectPrices();
    setPlatform(nextPlatform);
    const nextTable = tables.find((item) => item.platform === nextPlatform) || null;
    if (!nextTable) return;
    setPriceInputs(makePriceInputs(nextTable));
    setSelectedOptions(makeDefaultSelections(nextTable));
    const nextAccount = findGrossMarginAccount(
      (library?.accounts || []).filter((account) => account.platform === nextPlatform),
      accountName
    );
    if (nextAccount) applyAccountPrice(nextAccount, "custom");
  }

  function handleAccountNameChange(rawValue: string) {
    const value = getGrossMarginAccountDisplayName(rawValue);
    if (value === accountNameRef.current) return;
    clearProjectPrices();
    accountNameRef.current = value;
    setAccountName(value);
    setVideoAccountLookup({ status: "idle", message: "" });
    const nextAccount = findGrossMarginAccount(platformAccounts, value);
    if (nextAccount) applyAccountPrice(nextAccount, "custom");
  }

  function handleVideoUrlChange(value: string) {
    const nextUrl = normalizeVideoUrlInput(value);
    if (nextUrl !== videoUrl) clearProjectPrices();
    setVideoUrl(nextUrl);
    const nextPlatform = detectVideoPlatform(nextUrl);
    if (nextPlatform && nextPlatform !== platform) handlePlatformChange(nextPlatform);
  }

  function updateOriginalPrice(value: string) {
    setOriginalPrice(value);
    // 账号切换时清空返点与填账号报价在同一批更新内发生，读取最新 ref 避免沿用旧比例。
    if (rebateRateRef.current.trim()) {
      setDiscountPrice(formatAmountInput(toAmount(value) * (1 - toAmount(rebateRateRef.current) / 100)));
    }
  }

  function handleRebateRateChange(value: string) {
    rebateRateRef.current = value;
    setRebateRate(value);
    if (value.trim()) {
      setDiscountPrice(formatAmountInput(toAmount(originalPrice) * (1 - toAmount(value) / 100)));
    }
  }

  function applyAccountPrice(account: NonNullable<typeof matchedAccount>, preferredKind: AccountPriceKind) {
    const price = getGrossMarginAccountPrice(account, preferredKind);
    setAccountPriceKind(price.kind);
    updateOriginalPrice(String(price.value));
  }

  function handleAccountPriceKindChange(kind: AccountPriceKind) {
    setProjectSelection({ context: projectContext, id: "manual" });
    setAccountPriceKind(kind);
    if (matchedAccount) applyAccountPrice(matchedAccount, kind);
  }

  function clearProjectPrices() {
    setProjectSelection(null);
    setOriginalPrice("");
    setRebateRate("");
    rebateRateRef.current = "";
    setDiscountPrice("");
  }

  function handleProjectChange(id: string) {
    setProjectSelection({ context: projectContext, id });
    if (id === "manual") {
      setOriginalPrice("");
      setRebateRate("");
      rebateRateRef.current = "";
      setDiscountPrice("");
    }
  }

  async function handleRefresh() {
    setBusy("refresh");
    try {
      const result = await getGrossMarginLibrary({ fresh: true });
      setLibrary(result);
      applyLibraryTable(result, platform);
      notify(result.accountSourceFallback
        ? { tone: "warning", message: result.accountSourceWarning || "在线账号同步失败，当前展示缓存" }
        : { tone: "success", message: "毛利单价表已刷新" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "刷新失败" });
    } finally {
      setBusy("");
    }
  }

  async function handleSavePriceTable() {
    if (!table) return;
    setBusy("prices");
    try {
      const result = await saveGrossMarginPriceTable({
        platform: table.platform,
        items: table.items.map((item) => ({
          ...item,
          unitPrice: (() => {
            const raw = priceInputs[item.id] ?? item.unitPrice;
            const amount = parseGrossMarginAmount(raw);
            if ((typeof raw === "string" && !raw.trim()) || amount === null) throw new Error(`${item.name}单价必须是有效的非负数字`);
            return amount;
          })()
        }))
      });
      setLibrary(result.library);
      setPriceInputs(makePriceInputs(result.table));
      notify({ tone: "success", message: `${formatPlatform(table.platform)}单价表已保存` });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "保存单价表失败" });
    } finally {
      setBusy("");
    }
  }

  async function handleSaveFullPriceTable(items: GrossMarginPriceTableSaveItem[]) {
    if (!table) return;
    setBusy("price-editor");
    try {
      const result = await saveGrossMarginPriceTable({ platform: table.platform, items });
      setLibrary(result.library);
      setPriceInputs(makePriceInputs(result.table));
      setSelectedOptions(makeDefaultSelections(result.table));
      setPriceEditorOpen(false);
      notify({ tone: "success", message: `${formatPlatform(table.platform)}单价表已保存` });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "保存单价表失败" });
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function handleExportReview() {
    if (busy) return;
    if (validationError) {
      notify({ tone: "error", message: validationError });
      return;
    }
    if (!videoUrl.trim()) {
      notify({ tone: "error", message: "请先补视频链接，再导出文案" });
      return;
    }
    if (renderedReviewTemplate.error) {
      notify({ tone: "error", message: renderedReviewTemplate.error });
      return;
    }
    setBusy("export");
    let copied = false;
    try {
      // 导出时重新填充当天日期，避免页面跨日停留后复制昨日文案。
      const reviewText = renderGrossMarginReviewTemplate(reviewTemplate.content, reviewTemplateValues);
      try {
        await copyText(reviewText);
        copied = true;
      } catch {
        // 剪贴板权限失败不应阻止保存，保存后提供手动复制入口。
      }
      if (platform === "douyin") {
        notify(copied
          ? { tone: "success", message: "文案已复制" }
          : {
            tone: "warning",
            message: "浏览器未允许复制，请打开文案后手动复制。",
            action: { label: "查看文案", onClick: () => setTemplateModalOpen(true) },
            durationMs: 15000
          });
        return;
      }
      const result = await saveGrossMarginMonitorRecord({
        platform,
        accountName: matchedAccount?.name || accountName,
        projectOrderId: selectedProject?.id,
        videoUrl,
        sourceText: reviewText,
        targetStats: Object.fromEntries(
          calculation.lines
            .filter((line) => line.quantity > 0)
            .map((line) => [line.service, toAbsoluteMetricValue(line)])
        )
      });
      setLibrary(result.library);
      notify(copied
        ? { tone: "success", message: "文案已复制，监控目标已保存" }
        : {
          tone: "warning",
          message: "监控目标已保存，但浏览器未允许复制。请打开文案，选中预览文字后手动复制。",
          action: { label: "查看文案", onClick: () => setTemplateModalOpen(true) },
          durationMs: 15000
        });
    } catch (error) {
      notify({
        tone: "error",
        message: platform === "douyin"
          ? `导出文案失败：${error instanceof Error ? error.message : "请稍后重试"}`
          : `${copied ? "文案已复制，但监控保存失败" : "文案未复制，监控保存失败"}：${error instanceof Error ? error.message : "请稍后重试"}`
      });
    } finally {
      setBusy("");
    }
  }

  async function handleSaveReviewTemplate(value: string) {
    setBusy("template");
    try {
      const result = await saveGrossMarginReviewTemplate({ platform, content: normalizeTemplateText(value) });
      setLibrary(result.library);
      setTemplateModalOpen(false);
      notify({ tone: "success", message: `${formatPlatform(platform)}文案模板已永久保存` });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "保存文案模板失败" });
    } finally {
      setBusy("");
    }
  }

  async function handleBulkMonitorSubmit(input: { template: string; createProject: boolean; projectName: string }) {
    setBusy("bulk-monitor");
    try {
      const result = await bulkSaveGrossMarginMonitorRecords(input);
      setLibrary(result.library);
      setBulkMonitorModalOpen(false);
      notify({
        tone: "success",
        message: result.project
          ? `已添加 ${result.records.length} 条监控，并创建项目「${result.project.name}」`
          : `已添加 ${result.records.length} 条监控`
      });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "添加监控失败" });
    } finally {
      setBusy("");
    }
  }

  function handleImportTemplate(template: GrossMarginImportedTemplate) {
    const imported = buildImportedMaintenanceState({
      accountName,
      accounts: library?.accounts || [],
      currentPlatform: platform,
      currentPriceInputs: priceInputs,
      currentTable: table,
      currentVideoUrl: videoUrl,
      tables,
      template
    });
    setPlatform(imported.platform);
    clearProjectPrices();
    setPriceInputs(imported.priceInputs);
    setSelectedOptions(imported.selectedOptions);
    setQuantityInputs(imported.quantityInputs);
    accountNameRef.current = imported.accountName;
    setAccountName(imported.accountName);
    setVideoUrl(imported.videoUrl);
    if (imported.matchedAccount) applyAccountPrice(imported.matchedAccount, "custom");
    setImportModalOpen(false);
    notify({
      tone: "success",
      message: `已导入${template.metrics.length}个维护项${template.videoUrl ? "，链接已填" : ""}`
    });
  }

  return {
    projectOrders,
    selectedProject,
    projectSelectionValue: selectedProject?.id || (projectSelection?.context === projectContext ? projectSelection.id : "choose"),
    projectMonth: projects.source?.month || "",
    projectSourceError: projects.error,
    projectSourceLoading: projects.loading,
    refreshProjects: projects.refresh,
    handleProjectChange,
    accountName,
    accountPriceKind,
    activePricePanelServiceConfigs,
    activeServiceConfigs,
    bulkMonitorModalOpen,
    busy,
    calculation,
    configuredPriceCount,
    discountPrice,
    rebateRate,
    engagementTarget,
    importModalOpen,
    library,
    loading,
    matchedAccount,
    originalPrice,
    platform,
    platformAccounts,
    priceEditorOpen,
    priceInputs,
    quantityInputs,
    reviewTemplate,
    reviewTemplateLineCount,
    reviewTemplateValues,
    selectedOptions,
    splitDeliveryEnabled,
    table,
    templateModalOpen,
    videoUrl,
    videoAccountLookup,
    validationError,
    closeBulkMonitorModal: () => setBulkMonitorModalOpen(false),
    closeImportModal: () => setImportModalOpen(false),
    closePriceEditor: () => setPriceEditorOpen(false),
    closeTemplateModal: () => setTemplateModalOpen(false),
    handleAccountNameChange,
    handleBulkMonitorSubmit,
    handleAccountPriceKindChange,
    handleRebateRateChange,
    handleExportReview,
    handleImportTemplate,
    handlePlatformChange,
    handleRefresh,
    handleSaveFullPriceTable,
    handleSavePriceTable,
    handleSaveReviewTemplate,
    handleVideoUrlChange,
    openBulkMonitorModal: () => setBulkMonitorModalOpen(true),
    openImportModal: () => setImportModalOpen(true),
    openPriceEditor: () => setPriceEditorOpen(true),
    openTemplateModal: () => setTemplateModalOpen(true),
    setDiscountPrice,
    setPriceInput: (id: string, value: string) => setPriceInputs((current) => ({ ...current, [id]: value })),
    setQuantityInput: (service: GrossMarginServiceKind, value: string) =>
      setQuantityInputs((current) => ({ ...current, [service]: value })),
    setSelectedOption: (service: GrossMarginServiceKind, optionId: string) =>
      setSelectedOptions((current) => ({ ...current, [service]: optionId })),
    setSplitDeliveryEnabled,
    updateOriginalPrice
  };
}

export type GrossMarginWorkbenchController = ReturnType<typeof useGrossMarginWorkbench>;
