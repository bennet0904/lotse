# Language models and cost

The builder uses a language model to plan and write apps. You can use a model from a provider such as Anthropic or OpenAI, or a model that runs on your own computer.

## Setting up a model

Owners and admins open **Settings → Language models**:

| Setting               | Use                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Default model         | The model for projects that do not choose one, written as `provider:model`. Without a setting, `anthropic:claude-opus-5-5`. |
| Anthropic API key     | For `anthropic:` models. Create one in the [Anthropic Console](https://console.anthropic.com/settings/keys).                |
| OpenAI API key        | For `openai:` models.                                                                                                       |
| Ollama address        | Where [Ollama](https://ollama.com) runs, if not on this computer (`http://127.0.0.1:11434`).                                |
| LM Studio address     | Where [LM Studio](https://lmstudio.ai)'s server runs, if not on this computer (`http://127.0.0.1:1234`).                    |
| OpenAI-compatible API | Address and key of any other service that speaks the OpenAI API, e.g. an internal gateway.                                  |

Next to every setting, a badge says whether it is **Set here**, comes **From the environment**, or is **Not set**. Keys are stored encrypted and never shown again; the page only says whether one is set. To replace a key, enter the new one. To remove a value, enter a single space and save. Settings made here take precedence over [environment variables](../admin/configuration#language-models) of the installation.

## Choosing a model per app

Under **Options** on the start page you can name a different model for one app, e.g. `ollama:qwen3-coder` to try a local model, or a cheaper model for a simple page.

| Write                       | For                                                            |
| --------------------------- | -------------------------------------------------------------- |
| `anthropic:<model>`         | Anthropic models, e.g. `anthropic:claude-opus-5-5`             |
| `openai:<model>`            | OpenAI models                                                  |
| `ollama:<model>`            | A model in Ollama, e.g. `ollama:qwen3-coder`                   |
| `lmstudio:<model>`          | A model loaded in LM Studio                                    |
| `openai-compatible:<model>` | A model behind the OpenAI-compatible address from the settings |

## Local models

Local models run on your computer, cost nothing and send nothing anywhere. Building apps needs a capable coding model with tool use; small models often fail to finish an app. With Ollama:

```sh
ollama pull qwen3-coder
```

Then set the default model to `ollama:qwen3-coder`. The desktop app reaches Ollama on the same computer without further settings. For the web app, enter the address of the machine that runs Ollama.

## Cost

The **Usage** tab of a project shows requests, input and output tokens and the estimated cost per model. Estimates use the providers' list prices; your provider's invoice is what counts. Local models show no cost.

What drives cost:

- For every change the model reads the files it needs and the conversation so far; large apps and long conversations cost more per change.
- Automatic error corrections are further requests. Clear descriptions avoid rounds of fixes.
- The plan is cheap; building costs most.

## What the model receives

The model receives your descriptions, the plan, the project's files, and the output of commands it runs in the sandbox — with keys, tokens and secrets removed. It never receives provider accounts or the values of your app's secrets.
