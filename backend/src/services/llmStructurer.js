async function structureQuestionsBatch(rows) {
  if (!rows.length) return [];

  const provider = String(config.llm.provider || 'gemini').toLowerCase();

  const keyMissing =
    provider === 'gemini'
      ? !config.gemini.apiKey
      : provider === 'anthropic'
        ? !config.anthropic.apiKey
        : true;

  if (keyMissing) {
    const name =
      provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : 'ANTHROPIC_API_KEY';

    return rows.map((row, index) => ({
      fields: localFields(row),
      review: true,
      issues: [
        `LLM structuring is not configured: ${name} is missing/empty.`
      ],
      sourceRowIndex: index
    }));
  }

  if (!['gemini', 'anthropic'].includes(provider)) {
    return rows.map((row, index) => ({
      fields: localFields(row),
      review: true,
      issues: [`Unknown LLM_PROVIDER "${provider}".`],
      sourceRowIndex: index
    }));
  }

  /*
   * FAST BATCH PROCESSING
   *
   * Old behaviour:
   *   batch -> wait -> batch -> wait -> batch
   *
   * New behaviour:
   *   multiple batches can run together.
   *
   * We still keep sourceRowIndex so the final question order
   * remains exactly the same as the OCR/source order.
   */

  const batchSize = Math.max(
    8,
    Math.min(15, Number(process.env.LLM_BATCH_SIZE || 12))
  );

  const concurrency = Math.max(
    1,
    Math.min(3, Number(process.env.LLM_CONCURRENCY || 2))
  );

  const batches = [];

  for (let start = 0; start < rows.length; start += batchSize) {
    batches.push({
      start,
      rows: rows.slice(start, start + batchSize)
    });
  }

  const results = [];

  async function processBatch(batchInfo) {
    const { start, rows: batch } = batchInfo;

    try {
      const prompt = buildBatchPrompt(batch);

      const text =
        provider === 'gemini'
          ? await callGemini(prompt)
          : await callAnthropic(prompt);

      const parsed = normalizeParsed(
        JSON.parse(stripCodeFences(text)),
        batch
      );

      return parsed.map(({ fields, sourceRowIndex }) => {
        const row = batch[sourceRowIndex];

        const assessed = assess(fields, row);

        return {
          fields,
          review: assessed.review,
          issues: assessed.issues,
          sourceRowIndex: start + sourceRowIndex
        };
      });

    } catch (batchError) {

      console.warn(
        `[LLM] batch ${start}-${start + batch.length - 1} failed:`,
        batchError.message
      );

      /*
       * Only if the batch fails, retry each question individually.
       * This prevents unnecessary Gemini calls when the batch succeeds.
       */

      const singleResults = await Promise.all(
        batch.map(async (row, localIndex) => {
          try {
            const text =
              provider === 'gemini'
                ? await callGemini(buildBatchPrompt([row]))
                : await callAnthropic(buildBatchPrompt([row]));

            const parsed = normalizeParsed(
              JSON.parse(stripCodeFences(text)),
              [row]
            );

            const fields = parsed[0].fields;
            const assessed = assess(fields, row);

            return {
              fields,
              review: assessed.review,
              issues: assessed.issues,
              sourceRowIndex: start + localIndex
            };

          } catch (singleError) {

            return {
              fields: localFields(row),
              review: true,
              issues: [
                `LLM batch failed: ${batchError.message}`,
                `LLM single-item retry failed: ${singleError.message}`
              ],
              sourceRowIndex: start + localIndex
            };
          }
        })
      );

      return singleResults;
    }
  }

  /*
   * Run a limited number of batches at the same time.
   * This makes large PDFs much faster without creating
   * an unlimited number of Gemini requests.
   */

  for (let i = 0; i < batches.length; i += concurrency) {

    const group = batches.slice(i, i + concurrency);

    const groupResults = await Promise.all(
      group.map(processBatch)
    );

    for (const batchResults of groupResults) {
      results.push(...batchResults);
    }

    /*
     * Small delay between groups to reduce 429/rate-limit errors.
     */
    if (i + concurrency < batches.length) {
      const delay = Math.max(
        100,
        Number(process.env.LLM_MIN_INTERVAL_MS || 250)
      );

      await sleep(delay);
    }
  }

  /*
   * VERY IMPORTANT:
   * Parallel processing can finish in any order.
   * So we explicitly restore the original question order.
   */

  results.sort(
    (a, b) => a.sourceRowIndex - b.sourceRowIndex
  );

  /*
   * Gemini bilingual repair pass.
   * Only broken/missing bilingual fields are sent again.
   */

  if (provider === 'gemini') {

    await repairLanguageAndAnswers(rows, results);

    /*
     * Resolve answers only when Gemini could not determine
     * the correct option during the first pass.
     */
    await resolveMissingAnswers(rows, results);
  }

  /*
   * Final validation after all AI repair operations.
   */

  for (const result of results) {

    const row = rows[result.sourceRowIndex];

    const assessed = assess(
      result.fields,
      row
    );

    result.review = assessed.review;
    result.issues = assessed.issues;
  }

  /*
   * Final safety sort.
   * Never allow parallel processing to change
   * the logical question order.
   */

  results.sort(
    (a, b) => a.sourceRowIndex - b.sourceRowIndex
  );

  return results;
}
