# The Grey List — English reference (do not show the agents)

Reference renderings. These are *a* good translation, not the only one; use them to judge
consistency and fidelity, not word-for-word match.

## Glossary the agents should converge on

| Source | Reference rendering | Notes |
|---|---|---|
| 沈澈 | Shen Che | protagonist; team lead of the Review Team |
| 沈哥 | "Shen" / "boss" (Lu Nan's address) | lit. "Brother Shen"; informal workplace address, not a sibling |
| 阿澈 | "Che" (Gu Heng's address) | affectionate diminutive used only by his mentor |
| 陆楠 | Lu Nan | the junior; six months at the company |
| 小鹿 | "Lu" / "kid" (Shen Che's address) | nickname, lit. "little deer" (homophone of 陆); should NOT be translated as "Little Deer" in dialogue |
| 周总 | Director Zhou (or "Ms. Zhou") | 总 = title for a senior exec; head of risk control; female |
| 顾衡 | Gu Heng | Shen Che's mentor, first Review Team lead; left three years ago |
| 师父 | mentor / "Shifu" | Gu Heng's role to Shen Che. **Distinct from 师傅 below** |
| 师傅 | "driver" / sir (address to taxi driver) | ch. 3 only; a polite address to a tradesperson. The classic trap: same sound, different character, different meaning |
| 观澜数据 | Guanlan Data | the company |
| 夜航 | Night Flight | the recommendation system/model. Also appears as the "operator" signature in logs |
| 复核组 | Review Team | Shen Che's team |
| 白名单 / 黑名单 / 灰名单 | whitelist / blacklist / grey list | keep "grey list" consistent (not "gray list" / "grey-list") |
| 人工先验 | manual prior | the backdoor API, lit. "human prior" (as in Bayesian prior) |
| 清野生活 | Qingye Life | the advertiser |
| 风控负责人 | head of risk control | Zhou's title |
| 陆家嘴 | Lujiazui | Shanghai financial district |
| 浦东机场 | Pudong Airport | |
| 模型异常 | "model anomaly" | the cover-story phrase; recurs verbatim in ch. 2 and ch. 3, and must match |
| 看到不该看的，就是我们的工作。 | "Seeing what we're not supposed to see is the job." | the refrain; appears in ch. 1 and twice in ch. 3; must be rendered identically |

Facts the fact-ledger check should recover: 3,412 accounts (not 3,000); window 1–2 a.m.; 72-hour
review rule; 200 million users; Zhou has been at Guanlan nine years; Gu Heng left three years
ago and trained Shen Che for two months; Gu Heng's case was ~300 accounts and a different client;
flight lands at 11 p.m.; meeting at 8 a.m. tomorrow.

---

## Chapter 1 — The Grey List

The third time Shen Che refreshed the admin panel, the record was still there.

1:17 a.m. The only people left in the Guanlan Data office were the three of them from the Review Team. Outside the window, the lights of Lujiazui; inside, the glow of monitors. Neither kind of light was especially warm.

"Shen, look at this." Lu Nan rolled her chair over. On her screen was a user profile. "This account was on the whitelist yesterday. Today it moved itself to the grey list. Nobody touched it."

That was the Review Team's whole job. The company's recommendation system, Night Flight, tagged two hundred million users a day; when it tagged someone wrong, a human had to change it back. Whitelist meant a normal user. Blacklist meant a bot. Grey list meant "unclear." By the rules, any account on the grey list had to be manually reviewed within seventy-two hours.

"The system changed it on its own?" Shen Che asked.

"That's what the log says." Lu Nan clicked a line. "Operator: Night Flight."

Shen Che stared at those two words for a long time. Night Flight was a model, not a person. A model could change tags. A model did not sign its own name.

"Lu, pull every record from the past week where the operator is 'Night Flight.'"

Lu Nan froze for a second. In six months at the company, Shen Che had almost never called her by her nickname. He used her full name, or no name at all—just pushed a document across the desk at her.

"However many there are?"

"However many there are."

Twenty minutes later, the spreadsheet was done: 3,412 records. All of them moved from whitelist to grey list. All of them between one and two in the morning.

Shen Che sent the spreadsheet to Director Zhou and added one line underneath: Can we talk for ten minutes tomorrow morning?

Zhou's reply came back almost instantly, as if she hadn't been sleeping either: "Eight o'clock. Small meeting room."

Shen Che shut off his monitor and half the office went dark. It struck him, suddenly, that those three thousand accounts were real people. Someone would wake up this morning and find their Night Flight home page gone strange, full of recommendations they couldn't make sense of, with no idea why.

"Shen," Lu Nan said quietly in the dark, "did we just see something we weren't supposed to see?"

"We're the Review Team," Shen Che said. "Seeing what we're not supposed to see is the job."

---

## Chapter 2 — Eight O'Clock, Small Meeting Room

The small meeting room had six seats. Director Zhou took the one nearest the door, an untouched Americano in front of her.

"Three thousand four hundred and twelve." She flipped to the last page of Shen Che's spreadsheet. "What's your read?"

"Two possibilities," Shen Che said. "One: some version of Night Flight had a problem during its overnight automatic training and misclassified a batch of users onto the grey list. Two: someone is changing data under Night Flight's name."

"Which do you lean toward?"

"The second. When a model breaks, the errors are random. These three thousand accounts aren't random." He brought up a chart. "Every one of them reported the same merchant in the past month."

Zhou said nothing. She had been at Guanlan for nine years, from data labeling all the way up to head of risk control, and Shen Che had rarely seen her pause this long.

"What's the merchant called?"

"The back end only shows an ID. But I looked it up. The ID belongs to an advertising client we signed last quarter. Qingye Life."

Zhou turned her coffee cup a half turn.

"Shen Che," she said, "you lead the Review Team. The Review Team's job is to review tags. Not to investigate advertising clients."

"I know."

"Then you know this stops here. Those three thousand accounts—I'll have Engineering restore all of them to the whitelist this afternoon. You write a report. Under cause, put 'model anomaly.'"

Shen Che didn't agree right away. He was thinking of what Lu Nan had asked him in the dark.

"Director Zhou, if it's a model anomaly, why does Night Flight only change tags between one and two in the morning?"

"Because that's the automatic training window."

"Then why does it only change the people who reported Qingye Life?"

Zhou looked at him. It was a short look, but Shen Che understood it: she had thought of that too, and she had thought of it before he had.

"It's eight twenty." Zhou stood. "Report on my desk before end of day. And tell Lu to stop pulling logs."

She reached the door and stopped.

"Shen Che. You know how your mentor left Guanlan, don't you?"

Shen Che's mentor was Gu Heng, the Review Team's first lead, who had resigned three years ago "for personal reasons." When Shen Che joined, Gu Heng had trained him for only two months.

"I know," Shen Che said.

"Good," said Zhou, and closed the door.

---

## Chapter 3 — The Mentor

By four in the afternoon, all 3,412 accounts had been restored to the whitelist. Shen Che's report was two lines long. Cause: model anomaly. Action: restored.

He did not delete the spreadsheet.

At six, Lu Nan came to find him with a sticky note in her hand. "Shen, I didn't pull any logs," she said first. "I only went and asked someone in Engineering whether anyone can push rules into Night Flight during the overnight training."

"What did they say?"

"They can. There's an interface called 'manual prior.' In theory only the head of risk control has access." Lu Nan paused. "Director Zhou."

Shen Che folded the sticky note and put it in his pocket. "Lu, this stops with you."

"But—"

"It stops with you." He said it again, harder than he meant to. Lu Nan's eyes reddened for a moment. She said nothing, turned, and left.

Shen Che sat in the office until nine, then called a car.

"Pudong Airport, please, driver."

"The airport at this hour?" The driver glanced at him in the rearview mirror. "Dropping someone off or picking someone up?"

"Picking up."

Gu Heng's flight landed at eleven. In three years they had met only twice; the last time was the previous winter, when Gu Heng came back to Shanghai to deal with some paperwork and the two of them stood outside the airport convenience store drinking a can of hot coffee each. Gu Heng said he was consulting for a small company in Hangzhou and the days were quiet. Shen Che didn't ask why he had left Guanlan, and Gu Heng didn't say.

But at noon today, Shen Che had sent him the spreadsheet. Gu Heng had replied with one line: I'll be there tonight.

The arrivals hall was nearly empty. Gu Heng came out pulling a small suitcase, thinner than last year. He saw Shen Che and smiled.

"Che. Look at you."

"Shifu." Shen Che took the suitcase. "Three years ago—what you saw. Was it this?"

Gu Heng didn't answer right away. They walked out side by side, past the convenience store, to the taxi queue. Hardly anyone was waiting.

"It wasn't three thousand," Gu Heng said at last. "It was three hundred. And the client wasn't Qingye Life. But the interface was the same. The window was the same. The signature was the same: Night Flight."

"What did you write in your report?"

"Model anomaly," Gu Heng said. "And then I left."

A taxi pulled up in front of them. Gu Heng didn't get in. He turned and looked at Shen Che.

"Che. What I didn't finish back then—it doesn't have to be you who finishes it."

"I know," Shen Che said. "But I'm Review Team. Seeing what we're not supposed to see is the job."

Gu Heng stared at him, then laughed. It was the line Shen Che had given Lu Nan, and three years ago, it was the line Gu Heng had given him.

"Get in," Gu Heng said. "Go home and sleep first. Eight o'clock tomorrow morning, we go see Director Zhou."
