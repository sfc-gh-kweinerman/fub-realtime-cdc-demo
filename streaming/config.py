"""Shared configuration loaded from environment / .env file."""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # SQL Server
    SQLSERVER_HOST: str = os.getenv("SQLSERVER_HOST", "localhost")
    SQLSERVER_PORT: int = int(os.getenv("SQLSERVER_PORT", "1433"))
    SQLSERVER_USER: str = os.getenv("SQLSERVER_USER", "sa")
    SQLSERVER_PASSWORD: str = os.getenv("SQLSERVER_PASSWORD", "FUBDemo!2026")
    SQLSERVER_DATABASE: str = os.getenv("SQLSERVER_DATABASE", "JackHenry")

    @classmethod
    def sqlserver_conn_str(cls) -> str:
        return (
            "DRIVER={ODBC Driver 18 for SQL Server};"
            f"SERVER={cls.SQLSERVER_HOST},{cls.SQLSERVER_PORT};"
            f"DATABASE={cls.SQLSERVER_DATABASE};"
            f"UID={cls.SQLSERVER_USER};"
            f"PWD={cls.SQLSERVER_PASSWORD};"
            "TrustServerCertificate=yes;"
        )

    # Snowflake
    SNOWFLAKE_ACCOUNT: str = os.getenv("SNOWFLAKE_ACCOUNT", "")
    SNOWFLAKE_USER: str = os.getenv("SNOWFLAKE_USER", "")
    SNOWFLAKE_PASSWORD: str = os.getenv("SNOWFLAKE_PASSWORD", "")
    SNOWFLAKE_DATABASE: str = os.getenv("SNOWFLAKE_DATABASE", "FUB_DEMO")
    SNOWFLAKE_SCHEMA: str = os.getenv("SNOWFLAKE_SCHEMA", "BANKING")
    SNOWFLAKE_WAREHOUSE: str = os.getenv("SNOWFLAKE_WAREHOUSE", "FUB_DEMO_WH")

    # Snowpipe Streaming
    ENABLE_SNOWPIPE_STREAMING: bool = (
        os.getenv("ENABLE_SNOWPIPE_STREAMING", "false").lower() == "true"
    )
    SNOWFLAKE_PRIVATE_KEY_PATH: str = os.getenv("SNOWFLAKE_PRIVATE_KEY_PATH", "")
    SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: str = os.getenv(
        "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE", ""
    )

    # Generator
    DEFAULT_TPS: int = int(os.getenv("DEFAULT_TPS", "10"))
    SEED_CUSTOMERS: int = int(os.getenv("SEED_CUSTOMERS", "100"))
    SEED_ACCOUNTS: int = int(os.getenv("SEED_ACCOUNTS", "150"))

    # Services
    GENERATOR_PORT: int = int(os.getenv("GENERATOR_PORT", "8081"))
    POLLER_PORT: int = int(os.getenv("POLLER_PORT", "8080"))
    POLL_INTERVAL_MS: int = int(os.getenv("POLL_INTERVAL_MS", "500"))
