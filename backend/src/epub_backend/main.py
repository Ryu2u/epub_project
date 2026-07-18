"""FastAPI app 入口。

FastAPI 是一个现代 Python Web 框架，用于构建 API。
它自动生成 API 文档（Swagger UI），并利用 Python 类型标注来做参数校验。
"""

# FastAPI 核心类：用来创建 Web 应用实例
# HTTPException：手动抛出 HTTP 错误响应（如 404、422）
# Request：表示收到的 HTTP 请求对象
from fastapi import FastAPI, HTTPException, Request

# CORSMiddleware 是中间件，用于处理跨域请求（浏览器安全策略）
from fastapi.middleware.cors import CORSMiddleware

# JSONResponse 可以自定义返回 JSON 格式的 HTTP 响应
from fastapi.responses import JSONResponse

# 从 api/books.py 导入路由（里面定义了书籍相关的 API 端点）
from epub_backend.api.books import router as books_router
from epub_backend.config import get_settings

# 导入 EPUB 阅读器的错误类型，用于全局异常处理
from epub_backend.reader.errors import DuplicateFileError, EpubReaderError


# def 定义普通函数，这里用工厂模式创建 FastAPI 应用
# -> FastAPI 是返回类型标注，表示这个函数返回一个 FastAPI 实例
def create_app() -> FastAPI:
    """应用工厂函数：创建并配置 FastAPI 应用实例。

    使用工厂函数而非直接创建全局 app，方便测试时可以创建多个独立实例。
    """
    settings = get_settings()

    # 创建 FastAPI 应用实例，title/description 会显示在自动生成的 API 文档页面上
    app = FastAPI(
        title="EPUB Reader Backend",
        version="0.1.0",
        description="解析 EPUB 3 + 书籍库 API",
    )

    # 添加 CORS 中间件
    # CORS（跨域资源共享）是浏览器的安全机制：
    # 默认情况下，前端页面（如 localhost:5173）不能请求后端（如 localhost:8000）的 API，
    # 必须在后端显式允许，否则浏览器会拦截请求。
    app.add_middleware(
        CORSMiddleware,
        # allow_origins：允许哪些域名的前端访问
        allow_origins=settings.cors_origins,
        # allow_credentials：允许携带 Cookie 等身份凭证
        allow_credentials=True,
        # allow_methods=["*"]：允许所有 HTTP 方法（GET/POST/DELETE 等）
        allow_methods=["*"],
        # allow_headers=["*"]：允许所有请求头
        allow_headers=["*"],
    )

    # @app.get 是 FastAPI 的路由装饰器，将函数绑定到指定的 URL 路径
    # 当收到 GET /api/health 请求时，会执行下面的 health() 函数
    # dict[str, str] 是返回类型标注，表示"键和值都是字符串的字典"
    @app.get("/api/health")
    async def health() -> dict[str, str]:
        """健康检查端点，用于监控服务是否正常运行。"""
        return {"status": "ok"}

    # 将 books_router 中定义的所有端点注册到主应用
    # 这样 /api/books/* 相关的路由就全部挂载到应用上了
    app.include_router(books_router)

    # --- 全局异常处理器 ---
    # 当代码抛出特定异常时，FastAPI 会调用对应的 handler 来生成响应，
    # 而不是返回默认的 500 错误页面。这保证了错误响应格式统一。

    # @app.exception_handler(异常类) 装饰器注册一个全局异常处理器
    # 当代码中抛出 EpubReaderError 时，自动调用这个函数
    @app.exception_handler(EpubReaderError)
    async def epub_reader_error_handler(_request: Request, exc: EpubReaderError) -> JSONResponse:
        """统一领域错误响应格式：{ error: { code, message, phase, existing_book_id } }。"""
        # 根据错误代码映射 HTTP 状态码
        # 422 = 请求数据有问题；409 = 资源冲突（如重复上传）
        code_to_status = {
            "INVALID_CONTAINER": 422,
            "INCOMPLETE_METADATA": 422,
            "DRM_DETECTED": 422,
            "CORRUPT_EPUB": 422,
            "DUPLICATE_FILE": 409,
        }
        status_code = code_to_status.get(exc.code, 422)
        # 构造错误响应体
        body: dict = {
            "code": exc.code,
            "message": str(exc),
            "phase": exc.phase,
        }
        # isinstance() 检查 exc 是否是 DuplicateFileError 的实例
        # 如果是重复文件错误，额外返回已存在的书籍 ID，方便前端提示用户
        if isinstance(exc, DuplicateFileError) and exc.existing_book_id:
            body["existing_book_id"] = exc.existing_book_id
        return JSONResponse(status_code=status_code, content={"error": body})

    # 处理 FastAPI 内置的 HTTPException（如 404 Not Found）
    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
        """统一 HTTPException 也用 {error: {...}} 格式。"""
        # exc.detail 可能是 dict（我们传的）或 str（FastAPI 默认）
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": "HTTP_ERROR", "message": str(exc.detail)}},
        )

    return app


# 在模块级别创建应用实例
# uvicorn 会通过 "main:app" 来找到这个变量并启动服务
app = create_app()
