// TemplateForm.tsx - Template add/edit form component
interface TemplateFormProps {
  editing: string | null
  name: string
  setName: (v: string) => void
  promptTemplate: string
  setPromptTemplate: (v: string) => void
  variablesJson: string
  setVariablesJson: (v: string) => void
  projectPath: string
  setProjectPath: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  onCancel: () => void
}

export default function TemplateForm({
  editing, name, setName, promptTemplate, setPromptTemplate,
  variablesJson, setVariablesJson, projectPath, setProjectPath,
  onSubmit, onCancel,
}: TemplateFormProps) {
  return (
    <form onSubmit={onSubmit} className="p-3 border-b border-white/10 flex flex-col gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Template name"
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
        required
      />
      <textarea
        value={promptTemplate}
        onChange={(e) => setPromptTemplate(e.target.value)}
        placeholder="Prompt template (use {{variable}} for placeholders)"
        rows={4}
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30 resize-y"
        required
      />
      <input
        value={variablesJson}
        onChange={(e) => setVariablesJson(e.target.value)}
        placeholder='Variables JSON: [{"name":"x","description":"..."}]'
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
      />
      <input
        value={projectPath}
        onChange={(e) => setProjectPath(e.target.value)}
        placeholder="Default project path (optional)"
        className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          {editing ? 'Update' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded bg-white/5 text-white/60 hover:bg-white/10 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
