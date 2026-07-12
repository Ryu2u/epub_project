"""应用配置：从环境变量读取，pydantic-settings。"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """运行时配置。所有字段均可通过 EPUB_* 环境变量覆盖。"""

    model_config = SettingsConfigDict(
        env_prefix="EPUB_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    storage_dir: Path = Path("./data/storage")
    db_url: str = "sqlite+aiosqlite:///./data/library.db"
    max_upload_mb: int = 100
    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


_settings: Settings | None = None


def get_settings() -> Settings:
    """单例获取配置。"""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
