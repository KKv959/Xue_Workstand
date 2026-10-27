// Adapter only: all collection, ranking, filtering, analysis prompts and HTML
// generation are provided by the independently installed TrendRadar engine.
export const trendRadarRunner = String.raw`
import base64, contextlib, dataclasses, json, os, queue, shutil, signal, sqlite3, sys, tempfile, threading
from pathlib import Path

wire = sys.stdout
def emit(kind, **data):
    wire.write(json.dumps(dict(type=kind, **data), ensure_ascii=False) + "\n")
    wire.flush()

request = json.loads(sys.stdin.readline())
responses = queue.Queue()
def read_responses():
    for line in sys.stdin:
        responses.put(json.loads(line))
    os.kill(os.getpid(), signal.SIGTERM)
def terminate(signum, frame):
    raise SystemExit(130)
signal.signal(signal.SIGTERM, terminate)
threading.Thread(target=read_responses, daemon=True).start()
sys.path.insert(0, "/app")

def main():
    from trendradar import __version__
    from trendradar.core.loader import load_config
    from trendradar.__main__ import NewsAnalyzer
    from trendradar.ai.client import AIClient
    from trendradar.ai.filter import AIFilter
    from trendradar.ai.analyzer import AIAnalyzer
    from trendradar.ai.translator import AITranslator
    from trendradar.utils.time import get_configured_time

    # No credential is sent to Python. Model calls go back over stdin/stdout.
    def chat(self, messages, **kwargs):
        emit("model", messages=messages, maxTokens=kwargs.get("max_tokens", self.max_tokens) or 8000)
        response = responses.get(timeout=300)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["text"]
    AIClient.chat = chat
    AIClient.validate_config = lambda self: (True, "")
    AIFilter.load_interests_content = lambda self, interests_file=None: request["settings"]["interests"]

    # Upstream catches some model errors. Preserve the workbench's strict
    # failure contract instead of silently publishing a keyword/raw-text fallback.
    for method_name in ("classify_batch", "extract_tags"):
        original = getattr(AIFilter, method_name)
        def strict(self, *args, _original=original, **kwargs):
            result = _original(self, *args, **kwargs)
            if result is None:
                raise RuntimeError("TrendRadar AI 筛选失败，请检查模型输出后重试")
            return result
        setattr(AIFilter, method_name, strict)

    analysis_result = None
    analysis_error = None
    original_analyze = AIAnalyzer.analyze
    def analyze(self, *args, **kwargs):
        nonlocal analysis_result, analysis_error
        emit("progress", stage="analysis", message="正在生成 TrendRadar 五板块分析", progress=75)
        try:
            result = original_analyze(self, *args, **kwargs)
        except Exception as error:
            analysis_error = str(error)
            raise
        if not result.skipped and (not result.success or result.error):
            analysis_error = result.error or "模型未返回有效分析"
            raise RuntimeError("TrendRadar 分析失败：" + (result.error or "模型未返回有效分析"))
        analysis_result = result
        return result
    AIAnalyzer.analyze = analyze
    translation_error = None
    original_translate = AITranslator.translate_batch
    def translate(self, texts):
        nonlocal translation_error
        emit("progress", stage="translate", message="TrendRadar 正在翻译报告标题", progress=88)
        try:
            result = original_translate(self, texts)
        except Exception as error:
            translation_error = str(error)
            raise
        if result.fail_count or result.parsed_count != len([text for text in texts if text and text.strip()]):
            translation_error = "TrendRadar 标题翻译失败或返回数量不匹配，请检查模型输出后重试"
            raise RuntimeError(translation_error)
        return result
    AITranslator.translate_batch = translate

    config = load_config("/app/config/config.yaml")
    config["AI"] = {"MODEL": "openai/workbench", "API_KEY": "handled-by-workbench", "MAX_TOKENS": 8000}
    config["DEBUG"] = False
    config["ENABLE_NOTIFICATION"] = False
    config["SHOW_VERSION_UPDATE"] = False
    config["REPORT_MODE"] = request["settings"]["mode"]
    config["SCHEDULE"]["ENABLED"] = False
    config["FILTER"]["METHOD"] = request["settings"]["filter"]
    config["AI_ANALYSIS"].update(ENABLED=True, INCLUDE_RSS=True, MODE="follow_report", INCLUDE_RANK_TIMELINE=True)
    config["DISPLAY"]["REGIONS"].update(AI_ANALYSIS=True, RSS=True, HOTLIST=True)
    config["STORAGE"].update(BACKEND="local", RETENTION_DAYS=0)
    config["STORAGE"]["LOCAL"] = {"DATA_DIR": "output", "RETENTION_DAYS": 0}
    config["STORAGE"]["FORMATS"] = {"SQLITE": True, "HTML": True, "TXT": False}
    config["STORAGE"]["PULL"]["ENABLED"] = False
    today = get_configured_time(config.get("TIMEZONE", "Asia/Shanghai")).strftime("%Y-%m-%d")
    warnings = []

    with tempfile.TemporaryDirectory(prefix="workbench-trendradar-") as directory:
        root = Path(directory)
        # Copy only templates, never the model/notification credentials in YAML.
        for source in Path("/app/config").rglob("*.txt"):
            target = root / "config" / source.relative_to("/app/config")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (root / "config" / "ai_interests.txt").write_text(request["settings"]["interests"], encoding="utf-8")
        os.chdir(root)
        cache = {entry["kind"]: entry for entry in request.get("databases", []) if entry["day"] == today}
        for kind in ("news", "rss"):
            target = root / "output" / kind / (today + ".db")
            target.parent.mkdir(parents=True, exist_ok=True)
            if kind in cache:
                target.write_bytes(base64.b64decode(cache[kind]["data"], validate=True))
            else:
                source = Path("/app/output") / kind / (today + ".db")
                if source.exists():
                    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
                        src.backup(dst)

        analyzer = NewsAnalyzer(config=config)
        # Notifications are never part of this adapter. The user requested a
        # local report, not delivery to any externally configured recipients.
        analyzer._send_notification_if_needed = lambda *args, **kwargs: False
        analyzer._should_open_browser = lambda: False
        original_filter = analyzer.ctx.run_ai_filter
        def run_filter(*args, **kwargs):
            emit("progress", stage="filter", message="按关注方向提取标签、增量分类并排序", progress=50)
            result = original_filter(*args, **kwargs)
            if not result or not result.success:
                raise RuntimeError("TrendRadar AI 筛选失败：" + (result.error if result else "没有有效结果"))
            return result
        analyzer.ctx.run_ai_filter = run_filter
        matched_count = 0
        original_pipeline = analyzer._run_analysis_pipeline
        def pipeline(*args, **kwargs):
            nonlocal matched_count
            result = original_pipeline(*args, **kwargs)
            matched_count = sum(group.get("count", 0) for group in (result[0] or [])) + sum(group.get("count", 0) for group in (result[3] or []))
            return result
        analyzer._run_analysis_pipeline = pipeline
        try:
            emit("progress", stage="collect", message="TrendRadar 正在采集已配置热榜", progress=12)
            results, names, failed = analyzer._crawl_data()
            warnings.extend("热榜来源采集失败：" + str(name) for name in failed)
            emit("progress", stage="rss", message="TrendRadar 正在采集 RSS", progress=30)
            rss, rss_new, raw_rss, rss_urls = analyzer._crawl_rss_data()
            if analyzer._rss_source_failed:
                warnings.append(str(analyzer._rss_source_failed) + " 个 RSS 来源采集失败")
            if not any(results.values()) and not raw_rss:
                raise RuntimeError("TrendRadar 未取得可用资讯，请检查采集来源与网络；已保留上次报告")
            html_file = analyzer._execute_mode_strategy(analyzer._get_mode_strategy(), results, names, failed,
                rss_items=rss, rss_new_items=rss_new, raw_rss_items=raw_rss, rss_new_urls=rss_urls)
            if not html_file:
                raise RuntimeError("TrendRadar 未生成报告，请检查来源和报告配置")
            # _run_ai_analysis itself catches exceptions, so inspect its outcome
            # after the native pipeline before publishing anything.
            if translation_error:
                raise RuntimeError(translation_error)
            if analysis_error:
                raise RuntimeError("TrendRadar 分析失败：" + analysis_error)
            if analysis_result is None:
                warnings.append("本轮无匹配热榜，原生引擎未执行 AI 分析；请查看分组资讯或调整筛选条件")
            html = Path(html_file).read_text(encoding="utf-8")
            data = dataclasses.asdict(analysis_result) if analysis_result else {}
            counts = dict(hotlist=analyzer._hotlist_total_count, rss=analyzer._rss_total_count,
                matched=matched_count, analyzed=data.get("analyzed_news", 0))
            analyzer.ctx.cleanup()
            databases = []
            for kind in ("news", "rss"):
                db = root / "output" / kind / (today + ".db")
                if db.exists():
                    # A SQLite backup captures WAL changes in a standalone file.
                    standalone = root / (kind + ".db")
                    with sqlite3.connect(db) as src, sqlite3.connect(standalone) as dst:
                        src.backup(dst)
                    databases.append(dict(kind=kind, day=today, data=base64.b64encode(standalone.read_bytes()).decode()))
            emit("result", engineVersion=__version__, html=html, analysis={key: data.get(key, "") for key in
                ("core_trends", "sentiment_controversy", "signals", "rss_insights", "outlook_strategy")},
                counts=counts, warnings=warnings, databases=databases)
        finally:
            analyzer.ctx.cleanup()

try:
    # Native logs can contain article text/config diagnostics. Only structured
    # progress and results cross the boundary; no model credentials are logged.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        main()
except Exception as error:
    emit("error", message="TrendRadar 执行失败：" + str(error)[:600])
    sys.exit(1)
`;
