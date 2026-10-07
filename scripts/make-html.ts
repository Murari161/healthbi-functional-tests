import generateHtmlReport from '../src/html-report';

// Regenerate results/report.html from the latest components.jsonl / summary.jsonl.
generateHtmlReport().catch((err) => {
  console.error('make-html failed:', err);
  process.exit(1);
});
