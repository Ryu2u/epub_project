// Upload 页:拖拽 + 进度 + 错误展示 —— 深色图书馆风。
import { useRef, useState } from 'react'; // useRef: 获取 DOM 元素引用；useState: 管理组件状态
import { useNavigate } from 'react-router-dom'; // 编程式导航 hook，用于上传成功后跳转
import { ErrorBanner } from '../components/ErrorBanner';
import { useUpload } from '../hooks/useBooks'; // 封装了上传 mutation 的自定义 hook

export default function UploadPage() {
  const navigate = useNavigate();
  // useRef 用于获取隐藏的 <input type="file"> 元素，以便在点击拖拽区域时触发文件选择
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);   // 是否正在拖拽文件悬停在区域上方
  const [progress, setProgress] = useState(0);        // 上传进度百分比 0-100
  const [file, setFile] = useState<File | null>(null); // 用户选中的文件对象
  const upload = useUpload(); // TanStack Query 的 mutation hook，管理上传请求的生命周期

  // 选择文件后重置进度和 mutation 状态，准备新的上传
  const handleSelect = (f: File | null) => {
    if (!f) return;
    setFile(f);
    setProgress(0);
    upload.reset(); // 重置 mutation 的 error / isSuccess 等状态
  };

  const submit = async () => {
    if (!file) return;
    try {
      // mutateAsync 返回 Promise，await 等待上传完成
      // onProgress 回调接收 axios 的进度事件，计算百分比
      const result = await upload.mutateAsync({
        file,
        onProgress: (p) => setProgress(Math.round((p.loaded / p.total) * 100)),
      });
      // 上传成功后跳转到书籍详情页
      navigate(`/books/${result.book.id}`);
    } catch {
      // 错误不需要在这里处理，upload.error 会被 TanStack Query 自动维护并展示在 ErrorBanner 中
    }
  };

  return (
    <div
      className="app-shell relative min-h-screen bg-ink-900 text-cream"
      style={{ colorScheme: 'dark' }}
    >
      <div className="shell-atmosphere" aria-hidden="true" />

      {/* ---------- 顶栏 ---------- */}
      <header className="sticky top-0 z-20 border-b border-gold-400/10 bg-ink-900/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-4 sm:px-6">
          <button
            onClick={() => navigate('/')}
            className="shrink-0 rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200"
          >
            ← 返回
          </button>
          <h1 className="font-display text-xl text-cream">上传 EPUB</h1>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <main className="relative z-10 mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <ErrorBanner error={upload.error} />

        {/* 拖拽上传区域：使用 HTML5 拖放 API（Drag and Drop API） */}
        <div
          onDragOver={(e) => {
            e.preventDefault(); // 必须阻止默认行为，否则浏览器会直接打开文件
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            // dataTransfer.files 包含拖入的文件列表，取第一个
            handleSelect(e.dataTransfer.files[0] ?? null);
          }}
          onClick={() => fileInputRef.current?.click()} // 点击区域等同于点击隐藏的 input
          className={[
            'group cursor-pointer rounded-2xl border-2 border-dashed p-14 text-center transition-all duration-200',
            // dragOver 时高亮边框 + 暖金光晕阴影，提示用户"可以释放"
            dragOver
              ? 'border-gold-400 bg-gold-400/5 shadow-[0_0_40px_-10px_rgba(212,168,87,0.5)]'
              : 'border-gold-400/20 bg-ink-800/40 hover:border-gold-400/45 hover:bg-ink-800/70',
          ].join(' ')}
        >
          {/* 隐藏的真实 file input：用 ref 从外部触发它的 click */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".epub,.epb" // 仅接受 EPUB 格式文件
            className="hidden"
            onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex flex-col items-center gap-3">
              <FileIcon className="h-10 w-10 text-gold-400" />
              <div>
                <div className="font-display text-base text-cream">{file.name}</div>
                <div className="mt-1 text-sm tabular-nums text-cream-muted">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <UploadIcon
                className={`h-10 w-10 transition-colors ${dragOver ? 'text-gold-400' : 'text-cream-faint group-hover:text-gold-200'}`}
              />
              <div>
                <div className="font-display text-lg text-cream">拖拽 EPUB 文件到此处</div>
                <div className="mt-2 text-sm text-cream-muted">
                  或点击选择文件（.epub / .epb）
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 文件选中后才显示进度条和操作按钮 */}
        {file && (
          <div className="mt-6">
            {/* isPending 为 true 表示 mutation 正在执行（上传中），此时显示进度条 */}
            {upload.isPending && (
              <div className="mb-5">
                <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                  {/* 进度条：宽度由 progress 百分比动态控制，金色填充 + 外发光效果 */}
                  <div
                    className="h-full rounded-full bg-gold-400 shadow-[0_0_12px_-2px_rgba(212,168,87,0.8)] transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-2 text-xs tabular-nums text-cream-muted">上传中 {progress}%</div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {/* 取消按钮：清空已选文件并重置 mutation 状态，上传中时禁用 */}
              <button
                onClick={() => {
                  setFile(null);
                  upload.reset();
                }}
                disabled={upload.isPending}
                className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
              >
                取消
              </button>
              {/* 上传按钮：disabled:opacity-50 在上传中时降低透明度提示不可操作 */}
              <button
                onClick={submit}
                disabled={upload.isPending}
                className="rounded-full bg-gold-400 px-5 py-2 text-sm font-medium text-ink-900 shadow-[0_0_22px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200 disabled:opacity-50"
              >
                {upload.isPending ? '上传中...' : '开始上传'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 19h14" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 21V5a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}
