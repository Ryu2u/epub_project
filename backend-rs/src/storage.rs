// 文件系统工具：SHA-256 哈希 + 原子写入。
// 对应 Python storage/filesystem.py。

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 计算 SHA-256 哈希（十六进制字符串）
pub fn compute_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    // 每字节 2 个十六进制字符
    let mut hex = String::with_capacity(64);
    for b in result {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// 原子写入：先写临时文件 + fsync，再 rename 到目标。
/// 同目录写临时文件确保 rename 是原子的（同一文件系统）。
pub fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    // 临时文件：同目录，隐藏前缀
    let tmp_name = format!(".tmp_{}", uuid::Uuid::new_v4().simple());
    let tmp_path: PathBuf = dir.join(&tmp_name);

    // 写入 + fsync 确保数据落盘
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    // rename（原子操作）
    std::fs::rename(&tmp_path, target).map_err(|e| {
        // rename 失败时清理临时文件
        let _ = std::fs::remove_file(&tmp_path);
        e
    })?;

    Ok(())
}

/// 删除文件（忽略不存在的错误）
pub fn delete_file(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok()
}
