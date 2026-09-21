/**
 * ONE reviewable place for everything Jev sees and every threshold the policy uses.
 *
 * Jev (TypeSafe "System One") does not generate text. Each request carries the
 * current `state` (transcript + page snapshot) and a fan-out of typed questions
 * that are answered independently and in parallel. Code owns control flow.
 *
 * Rules applied here (from docs.typesafe.ai):
 *  - question ids are NOT sent to the model, so every `instructions` is a complete question
 *  - reference state with backticked paths (`transcript`, `page.site`, `elements`)
 *  - Choice options use the same contrastive shape {what, not_for, examples}
 *  - always include a `none` option; never ask Jev to count or generate
 */

export const MODEL = "jev-1.13.0"; // pinned: aliases move on release, thresholds below were tuned on this version

export const PRICE_PER_M_INPUT_TOKENS_USD = 0.042; // output tokens are free

// ---------------------------------------------------------------------------
// Perception limits (state size hurts accuracy + latency; keep it small)
// ---------------------------------------------------------------------------
export const MAX_ELEMENTS = 100; // hard cap on elements sent to Jev (255 is the Choice limit; latency grows with tokens)
export const MAX_ELEMENT_TEXT = 60; // chars per element label
export const MAX_STATE_CHARS = 24_000; // ~6k tokens; far below the 32k-token state limit
export const MAX_TRANSCRIPT_CHARS = 400;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export const DEBOUNCE_MS = 200; // wait this long after the last transcript update before asking Jev
export const MAX_INFLIGHT = 2; // overlapping Jev requests allowed; older ones are cancelled with AbortSignal
export const SILENCE_COMPLETE_MS = 900; // no new words for this long => treat command as complete
// Intents that carry free text (a query or text to type) cannot be acted on mid-sentence — "search
// for alan" is a complete-sounding command but the payload may still be growing. They wait for the
// recognizer's final result or this much silence.
export const PAYLOAD_SILENCE_MS = 600;
export const PAYLOAD_INTENTS = new Set(["search_web", "type_into_field", "select_option"]);
export const HIGHLIGHT_MS = 600; // element flash on the controlled page
export const CANDIDATE_TTL_MS = 8000; // numbered overlays stay this long

// ---------------------------------------------------------------------------
// Execution policy thresholds (the "why did it act / wait" numbers shown in the UI)
// ---------------------------------------------------------------------------
export const T = {
  intentConfidence: 0.55, // `intent` Choice confidence needed to act at all
  complete: 0.6, // `complete` Noul: user has finished the command (bypassed after SILENCE_COMPLETE_MS)
  isCommand: 0.5, // `is_command` Noul: user is addressing the browser at all
  destructive: 0.5, // `destructive` Noul above this => needs confirmation ...
  destructiveIntentConfidence: 0.9, // ... unless intent confidence is this high AND the user already said "confirm"
  targetConfidence: 0.45, // `target` Choice below this => show numbered candidate overlays instead of clicking
  targetTopProb: 0.35, // and the winning element must have at least this probability
  spanConfidence: 0.35, // `text_span` / `url_span` picks below this fall back to the heuristic candidate
  candidateCount: 3, // how many candidates to overlay when target is ambiguous
};

export const TARGET_INTENTS = new Set(["click_element", "type_into_field", "select_option"]);

// ---------------------------------------------------------------------------
// Sites (code owns URLs; Jev only picks the name)
// ---------------------------------------------------------------------------
export const SITE_HOME = {
  google: "https://www.google.com/",
  duckduckgo: "https://duckduckgo.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Main_Page",
  github: "https://github.com/",
  amazon: "https://www.amazon.com/",
  reddit: "https://www.reddit.com/",
  twitter_x: "https://x.com/",
  hacker_news: "https://news.ycombinator.com/",
  example_com: "https://example.com/",
};

// Search URL templates; `%s` is replaced with the URL-encoded query.
export const SITE_SEARCH = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  the_web: "https://duckduckgo.com/?q=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s&type=repositories",
  amazon: "https://www.amazon.com/s?k=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  twitter_x: "https://x.com/search?q=%s",
  hacker_news: "https://hn.algolia.com/?q=%s",
};

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

// ---------------------------------------------------------------------------
// Questions. All are asked in ONE request per transcript update (speculative fan-out).
// ---------------------------------------------------------------------------

export const INTENT_CRITERIA = {
  navigate_url: {
    what: "Open a specific website or URL by name (go to / open / visit; Russian: открой / перейди на / зайди на)",
    not_for: "Searching for a topic; clicking something already on the page. Russian «открой ссылку» means click_element.",
    examples: ["go to wikipedia", "open youtube", "take me to github.com", "visit example dot com", "открой Википедию", "перейди на YouTube", "открой example точка com"],
  },
  search_web: {
    what: "Search for a topic or phrase (search / find; Russian: найди / поищи / загугли), on the web or on a named site",
    not_for: "Typing into a named field («введи X») without searching; opening a site's homepage",
    examples: ["search for alan turing", "look up typesafe jev", "google cheap flights", "search wikipedia for cats", "найди Алана Тьюринга", "поищи Alan Turing", "найди на Википедии квантовую механику"],
  },
  click_element: {
    what: "Click / press / open an element on the current page (Russian: нажми / кликни / открой ссылку)",
    not_for: "Opening a website by name («открой YouTube»); typing text",
    examples: ["click the first result", "click sign in", "open the second link", "press the more information link", "нажми первую кнопку", "открой вторую ссылку", "нажми кнопку Sign in"],
  },
  type_into_field: {
    what: "Type or enter text into a field (Russian: введи / впиши / напиши / набери)",
    not_for: "Running a search on a search engine (that is search_web); pressing enter alone",
    examples: ["type hello world into the search box", "enter my email", "write good morning in the comment box", "введи Иван Петров в поле имени", "напиши привет мир в поле комментария", "набери test@example.com в поле email"],
  },
  select_option: {
    what: "Choose an option from a dropdown / select menu (Russian: выбери пункт / вариант)",
    not_for: "Clicking a link or button",
    examples: ["select english from the language dropdown", "choose the large size", "выбери English в списке", "выбери второй вариант"],
  },
  press_enter: {
    what: "Press Enter / Return or submit typed text (Russian: нажми Enter / отправь)",
    not_for: "Typing text; clicking a named button",
    examples: ["press enter", "hit enter", "submit", "нажми Enter", "отправь"],
  },
  scroll_down: {
    what: "Scroll down the page (Russian: прокрути / листай вниз)",
    not_for: "Scrolling up; navigating",
    examples: ["scroll down", "scroll down a bit", "go to the bottom", "page down", "прокрути вниз", "листай вниз", "прокрути до конца"],
  },
  scroll_up: {
    what: "Scroll up or to the top (Russian: прокрути вверх / наверх)",
    not_for: "Scrolling down; browser history back («назад»)",
    examples: ["scroll up", "back to the top", "page up", "прокрути наверх", "вернись наверх страницы"],
  },
  go_back: {
    what: "Go back in browser history (Russian: назад / вернись назад)",
    not_for: "Scrolling up or to the top («наверх»); closing a tab",
    examples: ["go back", "undo", "back", "previous page", "назад", "вернись назад"],
  },
  go_forward: {
    what: "Go forward in history (Russian: вперёд / перейди вперёд)",
    not_for: "Scrolling down",
    examples: ["go forward", "forward", "вперёд", "перейди вперёд"],
  },
  reload: {
    what: "Reload / refresh the current page (Russian: обнови / перезагрузи страницу)",
    not_for: "Navigating elsewhere",
    examples: ["reload", "refresh the page", "обнови страницу", "перезагрузи страницу"],
  },
  open_new_tab: {
    what: "Open a new empty tab (Russian: открой новую вкладку)",
    not_for: "Opening a website by name in the current tab",
    examples: ["open a new tab", "new tab", "открой новую вкладку", "новая вкладка"],
  },
  close_tab: {
    what: "Close the current tab (Russian: закрой вкладку)",
    not_for: "Going back",
    examples: ["close this tab", "close tab", "закрой эту вкладку", "закрой вкладку"],
  },
  switch_tab: {
    what: "Switch to another / next / previous tab (Russian: следующая / предыдущая вкладка)",
    not_for: "Opening or closing tabs",
    examples: ["next tab", "switch tab", "go to the other tab", "следующая вкладка", "перейди на предыдущую вкладку"],
  },
  confirm: {
    what: "Approve a pending action (yes / confirm; Russian: подтверждаю / да, выполняй)",
    not_for: "New commands",
    examples: ["confirm", "yes do it", "go ahead", "подтверждаю", "да, выполняй"],
  },
  cancel: {
    what: "Cancel a pending action (Russian: отмена / отменить / не надо)",
    not_for: "Going back in history",
    examples: ["cancel", "never mind", "stop", "отмена", "отменить", "не надо"],
  },
  none: {
    what: "Not a browser command, including Russian or English side-talk, fragments, silence and filler",
    not_for: "Anything that clearly matches another option",
    examples: ["um", "okay so", "what do you think", "the weather is nice", "после работы давай поедим", "что-то сегодня холодно"],
  },
};

export const SITE_CRITERIA = {
  google: "Google (google, google it, гугл)",
  duckduckgo: "DuckDuckGo",
  the_web: "A general web search with no site named (search the web, look it up online)",
  youtube: "YouTube (videos; ютуб)",
  wikipedia: "Wikipedia (the encyclopedia; Википедия)",
  github: "GitHub (code, repositories)",
  amazon: "Amazon (shopping)",
  reddit: "Reddit",
  twitter_x: "Twitter / X",
  hacker_news: "Hacker News (news.ycombinator.com, hn)",
  example_com: "example.com / example dot com / example точка com",
  other_named_site: "Some other website named explicitly in `transcript` (a domain or brand not listed above)",
  none: "No website or search engine is mentioned in `transcript`",
};

export const QUESTIONS = {
  intent: {
    instructions: {
      question: "Which browser action does the user ask for in Russian, English, or mixed-language `transcript`?",
      focus:
        "Judge the words said so far. Closed-set commands may be recognized early; payload commands must still include their object. If no action is recognizable pick none. `page` and `elements` describe what is on screen.",
    },
    criteria: INTENT_CRITERIA,
  },

  target: {
    instructions: {
      question:
        "Which element in `elements` is the one the user refers to in `transcript` (the thing to click, type into or select)? Each line of `elements` starts with the element id (e.g. e07), then its role and visible text; the options are those ids.",
      focus:
        "Match visible text, role and English/Russian position words (first/second, первый/второй). Mixed commands such as «нажми кнопку Sign in» refer to the unchanged English label. Pick none if no listed element matches.",
    },
    // criteria are built per request from the element list + none
  },

  site: {
    instructions: {
      question: "Which website or search engine does the user name in Russian or English `transcript`?",
      focus: "Only what is explicitly said. Википедия, Ютуб and Гугл are site names. Pick none if no site is named.",
    },
    criteria: SITE_CRITERIA,
  },

  complete: {
    instructions: {
      question:
        "Has the user finished saying the command in `transcript`, so it can be executed now without waiting for more words?",
      focus:
        "Speech arrives word by word. A command is complete when its verb and required object are present. «Найди» or «введи» alone is incomplete; closed-set commands like «вернись назад» are complete.",
    },
    criteria: {
      true: {
        what: "Complete, actionable command",
        examples: ["scroll down", "go back", "go to wikipedia", "search for alan turing", "click the first result", "прокрути вниз", "вернись назад", "открой новую вкладку", "найди Алана Тьюринга"],
      },
      false: {
        what: "Cut off before the required object; more words are clearly coming",
        examples: ["go to", "search for", "click the", "type", "open the", "перейди на", "найди", "введи", "нажми на"],
      },
    },
  },

  is_command: {
    instructions: {
      question:
        "Is Russian or English `transcript` an instruction addressed to a web browser (navigate, search, click, type, scroll, tabs, confirm/cancel)?",
      focus: "Chit-chat, narration, talking to another person, or a stray fragment in either language is not a command.",
    },
    criteria: {
      true: { what: "An imperative aimed at the browser", examples: ["scroll down", "go to youtube", "click sign in", "прокрути вниз", "открой YouTube", "нажми кнопку Sign in"] },
      false: {
        what: "Not directed at the browser",
        examples: ["I think we should get lunch", "um so yeah", "this is the demo", "what did you say", "после работы давай поедим", "нам надо завтра это обсудить"],
      },
    },
  },

  destructive: {
    instructions: {
      question:
        "Would carrying out the action in `transcript` on this `page` submit a form, place an order, pay, delete, send a message, post publicly, log out, or otherwise do something hard to undo?",
      focus: "Navigating, scrolling, reading, clicking links and typing into a box are NOT destructive.",
    },
    criteria: {
      true: {
        what: "Irreversible side effect",
        examples: ["click buy now", "delete this repository", "send the message", "post the comment", "click checkout", "нажми удалить репозиторий", "оформи заказ", "отправь сообщение"],
      },
      false: {
        what: "Reversible / read-only",
        examples: ["scroll down", "go to wikipedia", "click the first result", "type hello in the search box", "прокрути вниз", "открой Википедию", "введи привет в поле поиска"],
      },
    },
  },

  scroll_amount: {
    instructions: {
      question: "How far does the user want to scroll according to `transcript`?",
      focus: "Only relevant when scrolling; default is one screen. «назад» is history, while «наверх» is scrolling.",
    },
    criteria: [
      { what: "A little: a few lines (a bit, slightly, a little; немного, чуть-чуть)" },
      { what: "One screen / one page, or no amount specified (одну страницу)" },
      { what: "All the way to the end: the very top or bottom (до конца, в самый верх)" },
    ],
  },

  text_span: {
    instructions: {
      question:
        "Which option is exactly the text the user wants typed or searched, as spoken in `transcript`? Options are verbatim candidate spans.",
      focus:
        "Choose payload text only, without English or Russian command words or destination phrases such as «в поле имени». Pick none if nothing should be typed.",
    },
  },

  url_span: {
    instructions: {
      question: "Which option is the web address the user spoke in Russian or English `transcript`?",
      focus: "Pick none if no address is mentioned. Code normalizes spoken dot/slash and точка/слэш.",
    },
  },

  tab_direction: {
    instructions: {
      question: "When switching tabs, which tab does Russian or English `transcript` refer to?",
    },
    criteria: {
      next: "The next tab / the other tab / следующая вкладка / switch with no direction",
      previous: "The previous tab / the tab before / предыдущая вкладка",
      first: "The first tab",
      none: "Not about switching tabs",
    },
  },
};
