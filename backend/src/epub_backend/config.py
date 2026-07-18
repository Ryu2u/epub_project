"""应用配置：从环境变量读取，pydantic-settings。

pydantic-settings 是一个库，它能自动从环境变量或 .env 文件读取配置，
并把字符串自动转换成 Python 类型（如 int、list、Path 等）。
这样就不需要手动解析配置文件了。
"""

# pathlib.Path 是 Python 标准库中处理文件路径的类
# 比字符串拼接更安全、更跨平台（Windows/Linux/Mac 都能用）
from pathlib import Path

# BaseSettings 是 pydantic-settings 提供的配置基类
# SettingsConfigDict 用来告诉 BaseSettings 去哪里读取配置（环境变量、.env 文件等）
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """运行时配置。所有字段均可通过 EPUB_* 环境变量覆盖。

    继承 BaseSettings 后，每个类属性就是一个配置项。
    pydantic 会自动把环境变量的字符串值转换成属性声明的类型。
    """

    # model_config 是 pydantic v2 的特殊属性，用来配置模型自身的行为
    model_config = SettingsConfigDict(
        # env_prefix="EPUB_" 表示所有环境变量名都要加前缀 EPUB_
        # 例如 storage_dir 对应的环境变量名是 EPUB_STORAGE_DIR
        env_prefix="EPUB_",
        # 指定从 .env 文件读取配置（如果存在的话）
        env_file=".env",
        env_file_encoding="utf-8",
        # extra="ignore" 表示如果有未定义的字段就忽略，不报错
        extra="ignore",
    )

    # EPUB 存储目录路径，默认值是当前工作目录下的 ./data/storage
    storage_dir: Path = Path("./data/storage")
    # 数据库连接字符串，sqlite+aiosqlite 表示用异步 SQLite 驱动
    db_url: str = "sqlite+aiosqlite:///./data/library.db"
    # 上传文件大小上限（单位 MB）
    max_upload_mb: int = 100
    # CORS（跨域资源共享）允许的前端来源地址列表
    # list[str] 是 Python 3.9+ 的类型标注语法，表示"字符串列表"
    cors_origins: list[str] = ["http://localhost:5173"]

    # @property 装饰器让一个方法可以像属性一样访问（不用加括号）
    # 例如 settings.max_upload_bytes 而不是 settings.max_upload_bytes()
    @property
    def max_upload_bytes(self) -> int:
        """将 MB 转换为字节数。-> int 表示这个方法返回一个整数。"""
        return self.max_upload_mb * 1024 * 1024


# 模块级变量，用来缓存 Settings 实例
# Settings | None 是 Python 3.10+ 的联合类型语法，表示"Settings 或 None"
_settings: Settings | None = None


def get_settings() -> Settings:
    """单例获取配置。

    使用「单例模式」：整个应用运行期间只创建一次 Settings 实例。
    这样可以避免每次都重新读取环境变量和 .env 文件，提高性能。
    """
    # global 关键字声明我们要修改模块级变量 _settings（而不是创建局部变量）
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
