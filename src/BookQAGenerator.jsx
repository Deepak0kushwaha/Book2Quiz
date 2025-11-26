import React, { useState, useRef } from "react";
import { useStyletron } from "baseui";
import { Block } from "baseui/block";
import { Card, StyledBody, hasThumbnail as cardHasThumbnail } from "baseui/card";
import { Button, KIND as ButtonKind, SIZE as ButtonSize } from "baseui/button";
import { Input } from "baseui/input";
import { Slider } from "baseui/slider";
import { Select } from "baseui/select";
import { Textarea } from "baseui/textarea";
import { RadioGroup, Radio } from "baseui/radio";
import {
  Notification,
  KIND as NotificationKind,
} from "baseui/notification";
import { Tag, KIND as TagKind } from "baseui/tag";
import {
  HeadingXXLarge,
  HeadingSmall,
  ParagraphMedium,
  ParagraphSmall,
  LabelMedium,
} from "baseui/typography";
import {
  Upload,
  BookOpen,
  Check,
  AlertCircle,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";
import Tesseract from "tesseract.js";
import { jsonrepair } from "jsonrepair";

if (pdfjsLib?.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_MODEL =
  [
    import.meta.env.VITE_GEMINI_MODEL,
    import.meta.env.VITE_GEMINI_MODEL_NAME,
  ]
    .map((value) => value?.trim())
    .find(Boolean) || DEFAULT_GEMINI_MODEL;

const DIFFICULTY_OPTIONS = [
  { id: "Easy", label: "Easy" },
  { id: "Medium", label: "Medium" },
  { id: "Hard", label: "Hard" },
];

const QUESTION_TYPES = [
  { id: "Mixed", label: "Mixed" },
  { id: "Multiple Choice", label: "Multiple Choice" },
  { id: "Short Answer", label: "Short Answer" },
];

const LANGUAGE_OPTIONS = [
  { id: "English", label: "English only" },
  { id: "Hindi", label: "Hindi only" },
  { id: "Bilingual", label: "Bilingual (Hindi + English)" },
];

const BookQAGenerator = () => {
  const [css, theme] = useStyletron();
  const [file, setFile] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(5);
  const [totalPages, setTotalPages] = useState(0);
  const [difficulty, setDifficulty] = useState("Medium");
  const [qCount, setQCount] = useState(5);
  const [questionType, setQuestionType] = useState("Mixed");
  const [languagePreference, setLanguagePreference] = useState("Bilingual");

  const fileInputRef = useRef(null);

  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const droppedFile = event.dataTransfer?.files?.[0];
    if (droppedFile) {
      processFile(droppedFile);
    }
  };

  const handleFileChange = (event) => {
    const pickedFile = event.target.files?.[0];
    if (pickedFile) {
      processFile(pickedFile);
      event.target.value = "";
    }
  };

  const processFile = async (uploadedFile) => {
    if (uploadedFile.type !== "application/pdf") {
      setError("Please upload a valid PDF file.");
      return;
    }

    if (!pdfjsLib?.getDocument) {
      setError("PDF engine failed to initialize. Please refresh and try again.");
      return;
    }

    setFile(uploadedFile);
    setError("");
    setQuestions([]);
    setStatusText("Analyzing PDF structure...");
    setLoading(true);

    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      setTotalPages(pdf.numPages);
      setStartPage(1);
      setEndPage(Math.min(pdf.numPages, 10));
      setStatusText("PDF ready. Configure your quiz settings.");
      setLoading(false);
    } catch (err) {
      console.error(err);
      setError(
        "Failed to read PDF. It might be password protected or corrupted."
      );
      setLoading(false);
    }
  };

  const extractTextFromRange = async () => {
    if (!file) return;
    if (!pdfjsLib?.getDocument) {
      setError("PDF engine failed to initialize. Please refresh and try again.");
      return;
    }

    setLoading(true);
    setStatusText(`Reading pages ${startPage} to ${endPage}...`);
    setError("");

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      let fullText = "";
      const maxPages = pdf.numPages;
      const start = Math.max(1, startPage);
      const end = Math.min(maxPages, endPage);

      for (let i = start; i <= end; i++) {
        setStatusText(`Extracting text from page ${i}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        let pageText = textContent.items.map((item) => item.str).join(" ");

        if (needsOcr(pageText)) {
          setStatusText(`Running OCR on page ${i}...`);
          const ocrResult = await runOcrOnPage(page);
          if (ocrResult) {
            pageText = ocrResult;
          }
        }

        fullText += `--- Page ${i} ---\n${pageText}\n\n`;
      }

      await generateQuestions(fullText);
    } catch (err) {
      console.error(err);
      setError("Error extracting text from PDF.");
      setStatusText("");
      setLoading(false);
    }
  };

  const generateQuestions = async (textContext) => {
    setStatusText("AI is generating questions...");

    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

    if (!apiKey) {
      setError(
        "Gemini API key is missing. Add VITE_GEMINI_API_KEY to your .env file."
      );
      setLoading(false);
      return;
    }

  const languageInstruction = (() => {
    if (languagePreference === "English") {
      return `
        Language preference: English only.
        - Every question, option, answer, and explanation must be written entirely in natural English suitable for students.
        - When the source passage is in Hindi or another language, produce an accurate translation that preserves the nuance and technical vocabulary. If a term has no direct translation, include the transliterated Hindi term in parentheses.
        - Always include a short quote from the original language inside the "context" field followed by an English explanation so the learner can trace the source.
        - Never include Hindi sentences in the question, options, or answer fields when English is requested.
        - Set "questionTranslation" to null when English-only.
      `;
    }
    if (languagePreference === "Hindi") {
      return `
        Language preference: Hindi only.
        - Every question, option, answer, and explanation must be written entirely in natural, student-friendly Hindi.
        - When the source passage is in English or another language, translate the meaning into idiomatic Hindi while preserving the detail. If a concept lacks a standard Hindi term, include the English term in parentheses.
        - Always include a short quote from the original language in "context" followed by a Hindi explanation.
        - Never include English sentences in the question, options, or answer fields when Hindi is requested.
        - Set "questionTranslation" to null when Hindi-only.
      `;
    }
    return `
      Language preference: Bilingual (Hindi + English).
      - For every question you produce, provide two versions of the same question: one in Hindi and one in English. Both versions must convey the same meaning, level of detail, and tone.
      - Use the "question" field for the version that best matches the original source snippet, and ALWAYS include a faithful translation in the other language using the "questionTranslation" field. Ensure the translation is fluent, not word-for-word.
      - Populate "translationLanguage" with the language used in "questionTranslation". ("Hindi" if translation is Hindi, "English" if translation is English.)
      - Ensure options/answers/context follow the language of the primary "question". When helpful, you may add short parenthetical translations for tricky terminology.
      - Every object MUST include both languages when bilingual mode is selected.
    `;
  })();

    const prompt = `
      Analyze the following text from a book (pages ${startPage}-${endPage}). 
      Detect the languages present (focus on Hindi and English, but allow others).
      The user selected: ${languagePreference}.
      Generate ${qCount} ${difficulty} difficulty questions. 
      You MUST return exactly ${qCount} question objects (no more, no less) unless there is literally no textual detail available; if the text feels repetitive, focus on finer-grained concepts rather than reducing the count. If absolutely impossible, provide your best attempt but still include a note in the "context" field explaining why the detail was limited.
      ${languageInstruction}
      The questions should be of type: ${questionType}.
      
      Return the output strictly as a JSON array of objects with this format:
      [
        {
          "question": "Primary question text in the language indicated by 'language'",
          "questionTranslation": "Translated question text in the complementary language (must be filled when bilingual is requested, otherwise null)",
          "translationLanguage": "Hindi | English | null",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "answer": "Correct answer text (match one of the options exactly for MCQs)",
          "context": "A brief quote or concept from the text; include the original-language snippet plus a short explanation in the output language when translating",
          "type": "Multiple Choice | Short Answer",
          "language": "Hindi | English | Other"
        }
      ]

      If the text is too short or nonsensical, return an empty array.
      
      TEXT CONTENT:
      ${textContext.substring(0, 30000)} 
    `;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
            },
          }),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok || !data) {
        const apiMessage =
          data?.error?.message ||
          "Gemini API returned an unexpected response. Please verify your API key and model name.";
        throw new Error(`Gemini API ${response.status}: ${apiMessage}`);
      }

      const generatedText =
        data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!generatedText) {
        throw new Error(
          "Gemini API returned an empty response. Try reducing the page range or switching to a different model."
        );
      }

      const cleanedText = generatedText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
      const jsonPayload = jsonMatch ? jsonMatch[0] : cleanedText;

      let parsedQuestions;

      try {
        parsedQuestions = JSON.parse(jsonPayload);
      } catch (primaryErr) {
        try {
          const repaired = jsonrepair(jsonPayload);
          parsedQuestions = JSON.parse(repaired);
        } catch {
          throw new Error(
            "Gemini response was not valid JSON, even after repair. Try a smaller page range or adjust your prompt."
          );
        }
      }

      if (!Array.isArray(parsedQuestions)) {
        throw new Error("Gemini response format was invalid. Please try regenerating.");
      }

      if (parsedQuestions.length < qCount) {
        setError(`Gemini only returned ${parsedQuestions.length} of the ${qCount} requested questions. Try expanding the page range or reducing the desired count.`);
        setStatusText("");
        setLoading(false);
        return;
      }

      setQuestions(parsedQuestions);
      setStatusText("Questions generated successfully.");
      setLoading(false);
    } catch (err) {
      console.error(err);
      const defaultError =
        "Failed to generate questions. Please try a smaller page range or check your connection.";

      const normalizedMsg = err?.message ? err.message.toLowerCase() : "";

      if (normalizedMsg.includes("not found")) {
        setError(
          `${err.message} Update VITE_GEMINI_MODEL in your .env to one of the supported Gemini models.`
        );
      } else {
        setError(err.message || defaultError);
      }
      setStatusText("");
      setLoading(false);
    }
  };

  const downloadQA = () => {
    if (!questions.length || !file) return;

    const content = questions
      .map((q, i) => {
        let text = `Q${i + 1}: ${q.question}\nType: ${q.type}\n`;
        if (q.options && q.options.length > 0) {
          text += `Options:\n${q.options
            .map((o) => `- ${o}`)
            .join("\n")}\n`;
        }
        if (q.questionTranslation) {
          text += `Translated Question (${q.translationLanguage || "Other"}): ${q.questionTranslation}\n`;
        }
        text += `Answer: ${q.answer}\nLanguage: ${q.language || "Unknown"}\nContext: ${q.context}\n\n`;
        return text;
      })
      .join("-------------------\n\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file.name.replace(".pdf", "")}_QA.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const selectedDifficulty = DIFFICULTY_OPTIONS.find(
    (option) => option.id === difficulty
  );
  const selectedLanguagePref = LANGUAGE_OPTIONS.find(
    (option) => option.id === languagePreference
  );

  const getOcrLanguageCode = () => {
    switch (languagePreference) {
      case "English":
        return "eng";
      case "Hindi":
        return "hin";
      default:
        return "eng+hin";
    }
  };

  const runOcrOnPage = async (pdfPage) => {
    try {
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return "";
      }
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      const { data } = await Tesseract.recognize(canvas, getOcrLanguageCode());
      canvas.remove();
      return data?.text?.trim() || "";
    } catch (ocrError) {
      console.error("OCR failed:", ocrError);
      return "";
    }
  };

  const needsOcr = (text) => !text || text.replace(/\s+/g, "").length < 30;

  return (
    <Block
      backgroundColor={theme.colors.backgroundSecondary}
      minHeight="100vh"
      paddingTop="scale1000"
      paddingBottom="scale1000"
      paddingLeft="scale700"
      paddingRight="scale700"
    >
      <Block margin="0 auto" maxWidth="960px">
        <Block
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexDirection="column"
          marginBottom="scale900"
        >
          <Block
            display="flex"
            alignItems="center"
            justifyContent="center"
            width="64px"
            height="64px"
            backgroundColor={theme.colors.primary50}
            marginBottom="scale400"
            overrides={{
              Block: {
                style: {
                  borderRadius: "24px",
                },
              },
            }}
          >
            <BookOpen size={32} color={theme.colors.primary} />
          </Block>
          <HeadingXXLarge
            style={{ marginBottom: theme.sizing.scale400, textAlign: "center" }}
          >
            Book2Quiz
          </HeadingXXLarge>
          <ParagraphMedium style={{ textAlign: "center" }}>
            Upload a PDF textbook and turn it into guided study questions with
            one click.
          </ParagraphMedium>
        </Block>

        {error && (
          <Notification
            kind={NotificationKind.negative}
            onClose={() => setError("")}
            overrides={{
              Body: { style: { marginBottom: "16px" } },
            }}
          >
            {error}
          </Notification>
        )}

        {statusText && (
          <Notification
            kind={
              loading ? NotificationKind.info : NotificationKind.positive
            }
            closeable={false}
            overrides={{
              Body: { style: { marginBottom: "16px" } },
            }}
          >
            {statusText}
          </Notification>
        )}

        <Card
          hasThumbnail={cardHasThumbnail}
          overrides={{
            Root: { style: { marginBottom: "24px" } },
          }}
        >
          <StyledBody>
            <HeadingSmall
              style={{ marginBottom: theme.sizing.scale400, display: "flex" }}
            >
              Upload your book
            </HeadingSmall>
            <ParagraphSmall
              style={{ marginBottom: theme.sizing.scale500, color: "#475467" }}
            >
              Drag & drop a PDF or browse your files. We will automatically
              analyze the pages once uploaded.
            </ParagraphSmall>

            <input
              type="file"
              ref={fileInputRef}
              accept="application/pdf"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
            <Block
              role="button"
              tabIndex={0}
              aria-label="Upload PDF"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => {
                if (!loading) {
                  fileInputRef.current?.click();
                }
              }}
              onKeyDown={(event) => {
                if (loading) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={css({
                borderWidth: "3px",
                borderStyle: "dashed",
                borderColor: isDragging
                  ? theme.colors.primary
                  : theme.colors.borderOpaque,
                borderRadius: "20px",
                paddingTop: theme.sizing.scale900,
                paddingBottom: theme.sizing.scale900,
                paddingLeft: theme.sizing.scale900,
                paddingRight: theme.sizing.scale900,
                backgroundColor: isDragging
                  ? theme.colors.primary50
                  : theme.colors.backgroundTertiary,
                textAlign: "center",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.7 : 1,
                transition: "all 0.2s ease",
              })}
            >
              <Block
                display="flex"
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                gap="scale400"
              >
                <Upload size={32} color={theme.colors.primary} />
                <ParagraphSmall
                  style={{
                    color: theme.colors.contentPrimary,
                    fontWeight: 600,
                  }}
                >
                  Drop your PDF here or click to browse
                </ParagraphSmall>
                <ParagraphSmall style={{ color: theme.colors.contentSecondary }}>
                  Max range ~10 pages per request for best results.
                </ParagraphSmall>
                <Button
                  kind={ButtonKind.primary}
                  size={ButtonSize.compact}
                  disabled={loading}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!loading) {
                      fileInputRef.current?.click();
                    }
                  }}
                >
                  Browse PDF
                </Button>
              </Block>
            </Block>

            {file && (
              <div
                className={css({
                  marginTop: theme.sizing.scale600,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: theme.sizing.scale400,
                  alignItems: "center",
                })}
              >
                <Tag
                  closeable={false}
                  kind={TagKind.accent}
                >
                  {file.name}
                </Tag>
                {totalPages > 0 && (
                  <Tag
                    closeable={false}
                    kind={TagKind.neutral}
                  >
                    {totalPages} pages detected
                  </Tag>
                )}
                <Button
                  size={ButtonSize.compact}
                  kind={ButtonKind.tertiary}
                  onClick={() => {
                    setFile(null);
                    setQuestions([]);
                    setStatusText("");
                    setError("");
                  }}
                >
                  Change PDF
                </Button>
              </div>
            )}
          </StyledBody>
        </Card>

        {file && (
          <Card
            hasThumbnail={cardHasThumbnail}
            overrides={{
              Root: { style: { marginBottom: "24px" } },
            }}
          >
            <StyledBody>
              <HeadingSmall
                style={{ marginBottom: theme.sizing.scale500, display: "flex" }}
              >
                Configure your quiz
              </HeadingSmall>

              <Block
                display="grid"
                gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                gridGap="scale600"
              >
                <Block>
                  <LabelMedium>Start page</LabelMedium>
                  <Input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={String(startPage)}
                    onChange={(e) =>
                      setStartPage(
                        Math.max(1, parseInt(e.target.value || "1", 10))
                      )
                    }
                  />
                </Block>
                <Block>
                  <LabelMedium>End page</LabelMedium>
                  <Input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={String(endPage)}
                    onChange={(e) =>
                      setEndPage(
                        Math.max(1, parseInt(e.target.value || "1", 10))
                      )
                    }
                  />
                </Block>
              </Block>

              <Block
                display="grid"
                gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                gridGap="scale600"
                marginTop="scale600"
              >
                <Block>
                  <LabelMedium>Difficulty</LabelMedium>
                  <Select
                    options={DIFFICULTY_OPTIONS}
                    value={selectedDifficulty ? [selectedDifficulty] : []}
                    searchable={false}
                    clearable={false}
                    onChange={({ value }) => {
                      if (value && value.length > 0) {
                        setDifficulty(value[0].id);
                      }
                    }}
                  />
                </Block>
                <Block>
                  <LabelMedium>Question type</LabelMedium>
                  <RadioGroup
                    align="horizontal"
                    name="question-type"
                    onChange={(e) => setQuestionType(e.target.value)}
                    value={questionType}
                  >
                    {QUESTION_TYPES.map((option) => (
                      <Radio key={option.id} value={option.id}>
                        {option.label}
                      </Radio>
                    ))}
                  </RadioGroup>
                </Block>
                <Block>
                  <LabelMedium>Question language</LabelMedium>
                  <Select
                    options={LANGUAGE_OPTIONS}
                    value={selectedLanguagePref ? [selectedLanguagePref] : []}
                    searchable={false}
                    clearable={false}
                    onChange={({ value }) => {
                      if (value && value.length > 0) {
                        setLanguagePreference(value[0].id);
                      }
                    }}
                  />
                </Block>
              </Block>

              <Block marginTop="scale600">
                <Block
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                  marginBottom="scale300"
                >
                  <LabelMedium>Number of questions</LabelMedium>
                  <Tag
                    closeable={false}
                    kind={TagKind.accent}
                  >
                    {qCount}
                  </Tag>
                </Block>
                <Slider
                  value={[qCount]}
                  onChange={({ value }) => {
                    if (!value) return;
                    setQCount(Math.round(value[0]));
                  }}
                  min={3}
                  max={50}
                  step={1}
                  marks
                />
              </Block>

              <Block
                display="flex"
                justifyContent="flex-end"
                flexWrap="wrap"
                marginTop="scale700"
                className={css({ gap: theme.sizing.scale500 })}
              >
                <Button
                  kind={ButtonKind.secondary}
                  size={ButtonSize.default}
                  startEnhancer={() => <Download size={18} />}
                  onClick={downloadQA}
                  disabled={!questions.length}
                >
                  Download (.txt)
                </Button>
                <Button
                  startEnhancer={() => <RefreshCw size={18} />}
                  onClick={extractTextFromRange}
                  isLoading={loading}
                  disabled={loading}
                >
                  Generate questions
                </Button>
              </Block>
            </StyledBody>
          </Card>
        )}

        {questions.length > 0 && (
          <Block>
            <HeadingSmall
              style={{ marginBottom: theme.sizing.scale500, display: "flex" }}
            >
              Generated questions
            </HeadingSmall>
            {questions.map((question, index) => (
              <QuestionCard
                key={`${question.question}-${index}`}
                data={question}
                index={index}
                difficulty={difficulty}
              />
            ))}
          </Block>
        )}
      </Block>
    </Block>
  );
};

const QuestionCard = ({ data, index, difficulty }) => {
  const [css, theme] = useStyletron();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState(null);
  const [shortAnswer, setShortAnswer] = useState("");

  const isMCQ =
    data.type === "Multiple Choice" && data.options && data.options.length > 0;

  const getOptionStyle = (option) => {
    const baseStyle = {
      padding: `${theme.sizing.scale500} ${theme.sizing.scale600}`,
      borderRadius: theme.borders.radius400,
      border: `1px solid ${theme.colors.borderOpaque}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      cursor: isOpen ? "default" : "pointer",
      backgroundColor: theme.colors.backgroundPrimary,
      color: theme.colors.contentPrimary,
      marginBottom: theme.sizing.scale300,
      transitionProperty: "all",
      transitionDuration: "200ms",
    };

    if (!isOpen) {
      if (selectedOption === option) {
        baseStyle.borderColor = theme.colors.primary;
        baseStyle.backgroundColor = theme.colors.primary50;
        baseStyle.color = theme.colors.primary;
        baseStyle.fontWeight = 600;
      } else {
        baseStyle[":hover"] = {
          borderColor: theme.colors.primary500,
        };
      }
    } else {
      baseStyle.cursor = "default";
      if (option === data.answer) {
        baseStyle.borderColor = theme.colors.positive;
        baseStyle.backgroundColor = theme.colors.positive50;
        baseStyle.color = theme.colors.positive;
        baseStyle.fontWeight = 600;
      } else if (selectedOption === option) {
        baseStyle.borderColor = theme.colors.negative;
        baseStyle.backgroundColor = theme.colors.negative50;
        baseStyle.color = theme.colors.negative;
      } else {
        baseStyle.backgroundColor = theme.colors.backgroundTertiary;
        baseStyle.color = theme.colors.contentSecondary;
      }
    }

    return css(baseStyle);
  };

  const handleOptionClick = (option) => {
    if (isOpen) return;
    setSelectedOption(option);
  };

  return (
    <Card
      hasThumbnail={cardHasThumbnail}
      overrides={{
        Root: {
          style: {
            marginBottom: "16px",
            borderColor: theme.colors.borderTransparent,
          },
        },
      }}
    >
      <StyledBody>
        <Block
          display="flex"
          justifyContent="space-between"
          alignItems="flex-start"
          flexWrap="wrap"
          className={css({ gap: theme.sizing.scale400 })}
        >
          <Block flex="1" minWidth="220px">
            <ParagraphSmall style={{ color: theme.colors.contentSecondary }}>
              Question {index + 1}
            </ParagraphSmall>
            <HeadingSmall style={{ marginTop: theme.sizing.scale200 }}>
              {data.question}
            </HeadingSmall>
          </Block>
          <Button
            kind={ButtonKind.tertiary}
            size={ButtonSize.compact}
            startEnhancer={() =>
              isOpen ? (
                <ChevronUp size={18} />
              ) : (
                <ChevronDown size={18} />
              )
            }
            onClick={() => setIsOpen((prev) => !prev)}
          >
            {isOpen ? "Hide answer" : "Reveal answer"}
          </Button>
        </Block>

        {data.questionTranslation && (
          <Block
            marginTop="scale400"
            padding="scale400"
            backgroundColor={theme.colors.backgroundTertiary}
            className={css({ borderRadius: theme.borders.radius400 })}
          >
            <LabelMedium>
              Translated question ({data.translationLanguage || "Other"})
            </LabelMedium>
            <ParagraphSmall
              style={{
                marginTop: theme.sizing.scale100,
                color: theme.colors.contentPrimary,
              }}
            >
              {data.questionTranslation}
            </ParagraphSmall>
          </Block>
        )}

        <Block
          display="flex"
          flexWrap="wrap"
          className={css({
            gap: theme.sizing.scale400,
            marginTop: theme.sizing.scale500,
          })}
        >
          <Tag closeable={false} kind={TagKind.positive}>
            {data.type || "Mixed"}
          </Tag>
          <Tag closeable={false} kind={TagKind.neutral}>
            Difficulty: {difficulty}
          </Tag>
          <Tag closeable={false} kind={TagKind.accent}>
            Language: {data.language || "Auto"}
          </Tag>
          {data.questionTranslation && (
            <Tag closeable={false} kind={TagKind.accent}>
              Translation: {data.translationLanguage || "Other"}
            </Tag>
          )}
        </Block>

        {isMCQ && (
          <Block marginTop="scale500">
            {data.options.map((option, idx) => (
              <div
                key={`${option}-${idx}`}
                className={getOptionStyle(option)}
                onClick={() => handleOptionClick(option)}
              >
                <span>{option}</span>
                {isOpen && option === data.answer && (
                  <Check size={18} color={theme.colors.positive} />
                )}
                {isOpen &&
                  selectedOption === option &&
                  option !== data.answer && (
                    <AlertCircle size={18} color={theme.colors.negative} />
                  )}
              </div>
            ))}
          </Block>
        )}

        {!isMCQ && (
          <Block marginTop="scale500">
            <LabelMedium>Your answer</LabelMedium>
            <Textarea
              value={shortAnswer}
              onChange={(event) => setShortAnswer(event.target.value)}
              placeholder="Type your answer before revealing the solution..."
              overrides={{
                Root: {
                  style: {
                    marginTop: theme.sizing.scale300,
                  },
                },
              }}
              disabled={isOpen}
            />
          </Block>
        )}

        {!isMCQ && !isOpen && (
          <ParagraphSmall
            style={{
              marginTop: theme.sizing.scale500,
              fontStyle: "italic",
              color: theme.colors.contentSecondary,
            }}
          >
            Use the reveal button to view the answer.
          </ParagraphSmall>
        )}

        {isOpen && (
          <Block
            marginTop="scale600"
            padding="scale600"
            backgroundColor={theme.colors.positive50}
            overrides={{
              Block: {
                style: {
                  borderRadius: "16px",
                  border: `1px solid ${theme.colors.positive100}`,
                },
              },
            }}
          >
            <LabelMedium style={{ color: theme.colors.positive700 }}>
              Correct answer
            </LabelMedium>
            <ParagraphMedium
              style={{
                marginTop: theme.sizing.scale100,
                color: theme.colors.contentPrimary,
              }}
            >
              {data.answer}
            </ParagraphMedium>
            {data.context && (
              <ParagraphSmall
                style={{
                  marginTop: theme.sizing.scale400,
                  color: theme.colors.contentSecondary,
                  fontStyle: "italic",
                }}
              >
                "{data.context}"
              </ParagraphSmall>
            )}
          </Block>
        )}
      </StyledBody>
    </Card>
  );
};

export default BookQAGenerator;