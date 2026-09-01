// 一次性迁移工具：将 COS 启用前入库的旧书资源（封面 + EPUB 内嵌图片）批量上传到 COS。
//
// 用法：
//   cargo run --bin migrate_cos -- [--apply]
//
// 默认 dry-run：列出每个 asset 的 COS 状态（已存在 / 待上传 / 失败）和摘要。
// 加 --apply 才真正执行 PUT。
//
// 行为：
//   - 遍历 DB 里所有书
//   - 对每本书的每个 asset，HEAD COS 判断是否存在（is_exist）
//   - 不存在：从本地读取字节（上传封面从 covers/{id}，EPUB 资源从 .epb zip）
//     并 PUT 到 COS（Key 与运行时一致：books/{book_id}/assets/{asset_id}）
//   - COS 已存在：跳过
//   - 损坏/找不到的文件：记录并继续
//
// 安全：
//   - 重复跑幂等（已存在的不会重传）
//   - 任何单本书失败不影响其他书
//   - 不删除任何东西（连 .epb 本体都不碰）
//   - 默认 dry-run；要真传必须显式 --apply

// 共享模块走 lib crate（src/lib.rs），避免 #[path] 重复编译导致的 dead_code 误报
use epub_backend_rs::{config, cos, db};

use std::path::Path;

use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    // 解析命令行：默认 dry-run，--apply 才真正上传
    let args: Vec<String> = std::env::args().collect();
    let apply = args.iter().any(|a| a == "--apply");
    let dry_run = !apply;

    // 初始化 tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "migrate_cos=info,epub_backend_rs=info".into()),
        )
        .init();

    if dry_run {
        println!("[migrate] ** DRY-RUN 模式 ** 仅读取 COS 状态，不会真正 PUT");
        println!("[migrate] 加 --apply 参数才会执行上传:");
        println!("[migrate]    cargo run --bin migrate_cos -- --apply\n");
    } else {
        println!("[migrate] ** --apply 模式 ** 将真实执行 PUT 到 COS");
        println!("[migrate] 继续?  按 Ctrl-C 取消，3 秒后开始...");
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        println!("[migrate] 开始\n");
    }

    // 1. 加载配置
    let cfg = config::Config::from_env();
    let _ = std::fs::create_dir_all(&cfg.storage_dir);

    let Some(cos_cfg) = &cfg.cos else {
        anyhow::bail!(
            "未配置 EPUB_COS_* 环境变量。请在 backend-rs/.env 里设置 \
             EPUB_COS_SECRET_ID / SECRET_KEY / BUCKET / REGION 后再运行"
        );
    };
    println!(
        "[migrate] 目标: bucket={} region={} prefix={}",
        cos_cfg.bucket, cos_cfg.region, cos_cfg.key_prefix
    );

    let cos_client = std::sync::Arc::new(
        cos::CosClient::new(
            cos_cfg.secret_id.clone(),
            cos_cfg.secret_key.clone(),
            cos_cfg.bucket.clone(),
            cos_cfg.region.clone(),
            cos_cfg.key_prefix.clone(),
        )
        .context("初始化 COS client 失败")?,
    );

    // 2. DB pool
    let pool = db::init_pool(&cfg.database_url)
        .await
        .context("连接数据库失败")?;

    // 3. 列出所有书
    let books: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, file_path FROM books ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .context("列出 books 失败")?;

    println!("[migrate] 共 {} 本书待处理", books.len());

    let total_book_count = books.len();
    let mut total_books = 0usize;
    let mut total_assets = 0usize;
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut failed: Vec<(String, String, String)> = Vec::new(); // (title, asset_id, reason)

    for (book_id, title, file_path) in books {
        total_books += 1;

        // 查这本书所有 asset
        let assets: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
            "SELECT id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? ORDER BY is_cover DESC",
        )
        .bind(&book_id)
        .fetch_all(&pool)
        .await
        .with_context(|| format!("列出 assets 失败: book={book_id}"))?;

        if assets.is_empty() {
            continue;
        }

        println!(
            "[migrate] ({}/{}) {} ({}) assets={}",
            total_books,
            total_book_count,
            title.chars().take(40).collect::<String>(),
            book_id,
            assets.len()
        );

        for (asset_id, href, media_type, _size, _is_cover) in assets {
            total_assets += 1;

            // 计算 COS key
            let key = cos_client.make_key(&book_id, &asset_id);

            // 检查 COS 是否已有
            match cos_client.is_exist_object(&key).await {
                Ok(true) => {
                    skipped += 1;
                    continue;
                }
                Ok(false) => {} // 不存在，继续上传
                Err(e) => {
                    failed.push((
                        title.clone(),
                        asset_id.clone(),
                        format!("is_exist 检查失败:{e}"),
                    ));
                    continue;
                }
            }

            // 读字节
            let bytes_result = if href.starts_with("cover:") {
                let path = cfg.storage_dir.join("covers").join(&asset_id);
                std::fs::read(&path).map_err(|e| format!("读 cover 失败:{e}"))
            } else {
                let epb_path = cfg.storage_dir.join(
                    Path::new(&file_path).file_name().unwrap_or_default(),
                );
                read_epb_asset(&epb_path, &href)
                    .map_err(|e| format!("读 .epb 失败:{e}"))
            };

            let bytes = match bytes_result {
                Ok(b) => b,
                Err(reason) => {
                    failed.push((title.clone(), asset_id.clone(), reason));
                    continue;
                }
            };

            // 上传（dry-run 时跳过真实 PUT，但仍然计入"待上传"计数）
            if dry_run {
                println!(
                    "[dry-run] 待上传: key={key} size={} media_type={}",
                    bytes.len(),
                    media_type
                );
                uploaded += 1;
            } else if let Err(e) = cos_client
                .put_object(&key, bytes, &media_type)
                .await
            {
                failed.push((
                    title.clone(),
                    asset_id.clone(),
                    format!("put_object 失败:{e}"),
                ));
                continue;
            } else {
                uploaded += 1;
            }
        }
    }

    println!("\n========== 迁移摘要 ==========");
    println!("处理书籍: {}", total_books);
    println!("处理 asset: {}", total_assets);
    println!("已上传: {}", uploaded);
    println!("跳过(COS 已存在): {}", skipped);
    println!("失败: {}", failed.len());
    if !failed.is_empty() {
        println!("\n失败列表:");
        for (title, asset, reason) in &failed {
            println!("  - {title} / asset={asset} : {reason}");
        }
        std::process::exit(1);
    }
    println!("\n完成 ✓");
    Ok(())
}

fn read_epb_asset(epb_path: &Path, href: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(epb_path).map_err(|e| format!("打开 {epb_path:?}:{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("打开 ZIP:{e}"))?;
    let mut zf = archive
        .by_name(href)
        .map_err(|e| format!("ZIP 内找不到 {href}:{e}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut zf, &mut buf).map_err(|e| format!("读取失败:{e}"))?;
    Ok(buf)
}