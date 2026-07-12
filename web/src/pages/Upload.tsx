// Upload 页：拖拽 + 进度 + 错误展示
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { useUpload } from '../hooks/useBooks';

export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const upload = useUpload();

  const handleSelect = (f: File | null) => {
    if (!f) return;
    setFile(f);
    setProgress(0);
    upload.reset();
  };

  const submit = async () => {
    if (!file) return;
    try {
      const result = await upload.mutateAsync({
        file,
        onProgress: (p) => setProgress(Math.round((p.loaded / p.total) * 100)),
      });
      navigate(`/books/${result.book.id}`);
    } catch {
      // error 通过 upload.error 展示
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← 返回
          </button>
          <h1 className="text-xl font-semibold text-gray-900">上传 EPUB</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <ErrorBanner error={upload.error} />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleSelect(e.dataTransfer.files[0] ?? null);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={[
            'rounded-lg border-2 border-dashed p-12 text-center cursor-pointer transition-colors',
            dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white hover:border-gray-400',
          ].join(' ')}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".epub,.epb"
            className="hidden"
            onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="text-gray-700">
              <div className="font-medium">{file.name}</div>
              <div className="text-sm text-gray-500 mt-1">
                {(file.size / 1024).toFixed(1)} KB
              </div>
            </div>
          ) : (
            <div className="text-gray-500">
              <div className="text-lg">拖拽 EPUB 文件到此处</div>
              <div className="text-sm mt-2">或点击选择文件（.epub / .epb）</div>
            </div>
          )}
        </div>

        {file && (
          <div className="mt-6">
            {upload.isPending && (
              <div className="mb-4">
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-xs text-gray-500 mt-1">上传中 {progress}%</div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setFile(null);
                  upload.reset();
                }}
                disabled={upload.isPending}
                className="px-4 py-2 rounded-md text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={upload.isPending}
                className="px-4 py-2 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
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