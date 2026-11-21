"""Build bounded, same-repository context for a /codex answer request."""

import json
import os
import re
import subprocess
from pathlib import Path


def github(path):
    output = subprocess.check_output(["gh", "api", path], text=True)
    return json.loads(output)


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    repo = os.environ["GITHUB_REPOSITORY"]
    issue = event["issue"]
    question = event["comment"]["body"]
    path = f"repos/{repo}/issues/{issue['number']}/comments"
    # Ask for the final page, including conversations with more than 100 comments.
    last_page = max(1, ((issue.get("comments") or 1) + 99) // 100)
    comments = github(f"{path}?per_page=100&page={last_page}")
    if len(comments) < 10 and last_page > 1:
        comments = github(f"{path}?per_page=100&page={last_page - 1}") + comments

    related = []
    for number in list(dict.fromkeys(re.findall(r"(?<![\w/])#([1-9]\d{0,8})\b", question)))[:5]:
        if int(number) == issue["number"]:
            continue
        try:
            item = github(f"repos/{repo}/issues/{number}")
        except subprocess.CalledProcessError:
            related.append({"number": int(number), "unavailable": True})
        else:
            related.append({"number": item["number"], "title": item["title"], "body": (item["body"] or "")[:8000]})

    context = {
        "question": question,
        "issue": {"number": issue["number"], "title": issue["title"], "body": (issue["body"] or "")[:16000]},
        "recent_comments": [c["body"][:3000] for c in comments[-10:]],
        "related_tickets": related,
    }
    Path("ticket-context.json").write_text(json.dumps(context, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
