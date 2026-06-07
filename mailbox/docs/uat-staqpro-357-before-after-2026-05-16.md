# STAQPRO-357 Sub-task 3 — Before/After UAT

**M1 drafts, 10 pre-PR#81 + 10 post-PR#81. Inbound + drafted reply side-by-side.**

**Confound to flag in Linear:** DR-25 llama-cpp cutover landed in the same 24h window as PR#81 (both 2026-05-14 PDT on M1). The two arms therefore compare:
- **PRE** (`created_at < 2026-05-14 UTC`): `qwen3:4b-ctx4k` via **Ollama** (colon = Ollama signal), prompt WITHOUT quote-strip / WITHOUT thread-history / WITHOUT exemplars.
- **POST** (`created_at >= 2026-05-14 UTC`): `qwen3-4b-ctx4k` via **llama.cpp** (no colon = llama-cpp), prompt WITH quote-strip + thread-history + exemplars-when-available. One `cloud / gpt-oss:120b` outlier (draft 151) lives in this window for category coverage but is not strictly a PR#81 effect.

Category mix is biased toward `follow_up` + `internal` — no `inquiry`/`reorder` drafts in either window, so the newly-seeded exemplars (sub-task 2) don't fire here. The bake-off (STAQPRO-342) will need a synthetic inquiry/reorder test set to exercise them.

Body / draft truncated to 1200 chars per panel for readability.

---

## PRE-PR#81 (created < 2026-05-14 UTC) (n=10)

### Draft 123 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 21:01)

**From:** `taylor@curednutrition.com` → `dustin@heronlabsinc.com`  
**Subject:** Re: Follow up

**Inbound body:**

```
This formulation spreadsheet will be easier to work off of -

Cured Gummy Formulations
<https://docs.google.com/spreadsheets/d/1gdCU8ioQZ8n2ApChZpcxjfZGESfEWXBn/edit?gid=1247026853#gid=1247026853>


On Wed, May 13, 2026 at 2:47 PM Taylor O'Donnell <taylor@curednutrition.com>
wrote:

> Hey Dustin,
>
> It was great to connect with you today.
>
> Here is my address for the snacklebox:
>
> Taylor O'Donnell
> 12440 w 20th ave
> Lakewood, CO 80215
>
> For your GMP cert, can you verify its for CFR 111 for supplements and can
> you send it over?  Then also check if the co-man has an active cert as well
> ?  If they don't, we have someone here that can do bagging for us if you
> were to ship to us in Bulk.
>
> For your Cube mold, can you confirm if you have a 3g Cube mold ?  While we
> are open to using the cubes, If we wanted to get dome molds, do you know
> how much it would cost to switch that over ?
>
> As far as pricing goes, currently we are running 100k - 300k gummies per
> run at this all in pricing. We are providing the packaging and they are
> providing all inputs.
>
>
> [image: Screenshot 2026-04-30 at 3.09.40 PM.png]
>
> I dropped our spec sheets into this folder for your refere
…[truncated 1749 chars]
```

**Drafted reply:**

```
Thanks for the spreadsheet - I'll take a look. 

Regarding the GMP cert, I'll check with our compliance team to confirm if we have it for CFR 111. We also have a co-man for bagging in case we need to switch to bulk shipping. 

For the Cube mold, I'll confirm with our production team if we have a 3g Cube mold. If not, we can discuss the cost to switch to dome molds. 

I'll follow up with a quote once we have more clarity on the specs. 

— Heron Labs
```

---

### Draft 122 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 20:51)

**From:** `taylor@curednutrition.com` → `dustin@heronlabsinc.com`  
**Subject:** Follow up

**Inbound body:**

```
Hey Dustin,

It was great to connect with you today.

Here is my address for the snacklebox:

Taylor O'Donnell
12440 w 20th ave
Lakewood, CO 80215

For your GMP cert, can you verify its for CFR 111 for supplements and can
you send it over?  Then also check if the co-man has an active cert as well
?  If they don't, we have someone here that can do bagging for us if you
were to ship to us in Bulk.

For your Cube mold, can you confirm if you have a 3g Cube mold ?  While we
are open to using the cubes, If we wanted to get dome molds, do you know
how much it would cost to switch that over ?

As far as pricing goes, currently we are running 100k - 300k gummies per
run at this all in pricing. We are providing the packaging and they are
providing all inputs.


[image: Screenshot 2026-04-30 at 3.09.40 PM.png]

I dropped our spec sheets into this folder for your reference:
SPEC SHEETS
<https://drive.google.com/drive/folders/1XEZcCX1haMFPgd9uKiW0ESNXH2Iws-FU>
- Refer to Dream, Flow, and Serenity SKUs
Ingredient pricing
<https://docs.google.com/spreadsheets/d/1YbByKpH1tjXqIRvW4MzOqqO1bxM_y95Y/edit?usp=drive_web&ouid=102247154375422883851&rtpof=true>
-
botanicals

Let me know if you need anythi
…[truncated 721 chars]
```

**Drafted reply:**

```
Thanks for the follow-up. Let me confirm a few things:

- We do have a 3g Cube mold, but we don’t have a dome mold. If you’d like to switch, we’ll need to [confirm with operator: cost to switch to dome molds].

- Regarding the GMP cert, we’ll send it over once we verify it’s for CFR 111. The co-man does have an active cert, so no need for a replacement.

- For the pricing, we’re running 100k–300k gummies per run at this all-in price. We’ll share the quote once we have it.

Let me know if you need anything else. — Heron Labs
```

---

### Draft 121 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 20:36)

**From:** `hamza@eightnu.com` → `jt@heronlabsinc.com`  
**Subject:** Re: Hamza Digestion

**Inbound body:**

```
Hi Julie,

After doing a review of our launch budget, the increase in MOQ to 39,000
units alongside the higher unit cost impacts our initial launch costs and
cash flow.

We completely understand that ingredient costs may have changed and
appreciate your transparency. However, to help make this launch possible,
would it be possible to revisit the MOQ and keep it at the original 30,000
units with the updated pricing?

Alternatively, if there is any flexibility on ingredient costs then we
would greatly appreciate exploring options that could help bring down the
total upfront cost.

We are excited to move forward as this is the beginning of a long term
partnership. Our goal is to launch successfully and quickly scale into a
larger second order.

Thank you in advance, and we look forward to hopefully finding a solution
that works well for both sides.


On Wed, May 13, 2026 at 21:14 Julie Tran <jt@heronlabsinc.com> wrote:

> Hi Hamza,
>
> Here is a purchase order form for you to submit your order:
> https://melodious-fox-a64d6a.netlify.app/
>
> We need to adjust the unit price to account for rising ingredient costs
> from when we originally quoted so it is $6.79 at 39k PCs MOQ.
>
> Thank
…[truncated 40284 chars]
```

**Drafted reply:**

```
Hi Hamza,  

We understand your concern about the MOQ and costs. Let me check the current production calendar to confirm the lead time.  

We’re happy to revisit the MOQ if it helps keep costs down. If you’re open to adjusting the ingredient costs, we can explore options to reduce the total upfront cost.  

We’re committed to making this launch successful and building a strong partnership. Let me get back to you with the details.  

— Heron Labs
```

---

### Draft 120 — `internal` / `local` / `qwen3:4b-ctx4k` (2026-05-13 20:16)

**From:** `accounting@heronlabsinc.com` → `bpray9223@gmail.com`  
**Subject:** Re: Reminder: Invoice 260203-2 from Heron Labs, Inc. was due 05/09/2026

**Inbound body:**

```
Updated invoice has been sent.

On Wed, May 13, 2026, 10:51 Brian Pray <bpray9223@gmail.com> wrote:

> Yes, we only need what was produced (1,598 units) as of now. I thought you
> only had enough jars for ~1,500 units.
>
> We will likely look at starting another order in mid-late June.
>
> Brian Pray
> Owner/Founder - B&B Brands Inc.
> Mobile: 413-537-6415
>
>
> On Wed, May 13, 2026 at 1:41 AM Heron Accounting <
> accounting@heronlabsinc.com> wrote:
>
>> Are you reducing the purchase order from 2500 units to 1500 units? We
>> were planning on finishing the order next week, but if you only want 1500
>> units then we will close out this purchase order.
>>
>>
>> On Tue, May 12, 2026, 21:17 Brian Pray <bpray9223@gmail.com> wrote:
>>
>>> Hi Team,
>>>
>>> I'm still not following the math here. My understanding was that we
>>> agreed on 1,500 units total for this run, not 2,500 units for the PO, this
>>> change was requested a few months ago and I purchased the jars to support
>>> this order.
>>>
>>> Thanks,
>>> Brian Pray
>>> Owner/Founder - B&B Brands Inc.
>>> Mobile: 413-537-6415
>>>
>>>
>>> On Tue, May 12, 2026 at 6:46 PM Heron Accounting <
>>> accounting@heronlabsinc.com> wrote:
>>>

…[truncated 13913 chars]
```

**Drafted reply:**

```
We've sent an updated invoice. The total is $5,735.89, with $4,929.83 for the product and $751.06 for packing and handling. The remaining balance is $2,953.22. Let me know if you need any clarification. — Heron Labs
```

---

### Draft 119 — `internal` / `local` / `qwen3:4b-ctx4k` (2026-05-13 20:16)

**From:** `jt@heronlabsinc.com` → `hamza@eightnu.com`  
**Subject:** Re: Hamza Digestion

**Inbound body:**

```
Hi Hamza,

Here is a purchase order form for you to submit your order:
https://melodious-fox-a64d6a.netlify.app/

We need to adjust the unit price to account for rising ingredient costs
from when we originally quoted so it is $6.79 at 39k PCs MOQ.

Thank you



On Mon, May 11, 2026, 20:38 Julie Tran <jt@heronlabsinc.com> wrote:

> Hi Hamza,
>
> To maintain the quoted price of $6.26 from 10/21/26, the MOQ for our
> machine is 39,000 gummies.
> If you order below that quantity, the price will be $8.26 per unit because
> production will be manual, without using the machines.
>
> Product details:
>
>    - 30 count bag x 3.5g gummy
>    - bag provided by you
>    - 30 gummies packed into bags, labeled with Lot # and Best By Date,
>    Sealed, and Packed into casepack boxes for shipping
>
> Do you know what testing you want done? At a minimum, we will perform
> microbial testing for $165. Please see the attached Testing Fees
> document. Let us know if you'd like other testing; we will inquire and add
> it to the Testing Menu.
>
> Lead time is roughly 5 weeks from start to finish.
>
>    - Receive 50% down deposit to order materials
>    - 2 weeks for ingredients to arrive
>    - 1 week f
…[truncated 38655 chars]
```

**Drafted reply:**

```
Hi Hamza,

We've updated the unit price to $6.79 at 39k PCs MOQ to account for rising ingredient costs. The purchase order form is linked here: https://melodious-fox-a64d6a.netlify.app/

We'll need to confirm the ship date once warehouse confirms. Also, let me know if you need any adjustments to the order or if there's anything else we should be aware of.

— Heron Labs
```

---

### Draft 118 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 20:11)

**From:** `dylan@voidsleep.us` → `eddie@heronlabsinc.com`  
**Subject:** Re: Void sleep gummy

**Inbound body:**

```
Ok sweet thanks for the update I'm excited to try them. Can you please send
me a final ingredients/dose w/ other ingredients list for me to make the
label? Also lmk when you ship please and send the tracking info. Getting
hot in phoenix I dont want them to melt in my mailbox.

On Mon, May 11, 2026 at 5:50 PM Edward Riggins <eddie@heronlabsinc.com>
wrote:

> Sorry about that - we had to pull in more apigenin, but the sample was
> cooked today and will ship by wed/thursday depending on how quickly it
> finishes drying. Here was the mock-up generated based on how the color was
> coming out in the last sample - i think this is still pretty accurate.
>
> On Sun, May 10, 2026 at 8:25 PM Dylan Hauver <dylan@voidsleep.us> wrote:
>
>> Hey is the R&D almost done? You guys said in the call it would take about
>> a week more
>> On Sun, May 3, 2026 at 12:17 PM Julie Tran <jt@heronlabsinc.com> wrote:
>>
>>> Hey Dylan,
>>>
>>> We're still working on the r&d.
>>>
>>> The shape will be the square shape you've been getting the samples as,
>>> not a cube. The purple will be more opaque and darker.
>>>
>>> Eddie is going to pull up a representative purple shade.
>>>
>>>
>>> On Fri, May 1, 2026, 16:12 
…[truncated 54348 chars]
```

**Drafted reply:**

```
I'll send you the final ingredients list and dose info today. We'll also share the tracking number once it's shipped — and make sure it's sent on a cool day to prevent melting in the mailbox. Let me know if you need anything else. — Heron Labs
```

---

### Draft 117 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 19:41)

**From:** `Daniel.Anglin@aqualab.com` → `Eddie@elefanteinc.com`  
**Subject:** Re: Gummy Texture Problems?

**Inbound body:**

```
Hey Ed,

I hope you've had a great couple of months! I've attached current quotes on
the Aqualab 4TE and TDL2 here. They haven't changed since the last time we
spoke but they had expired dates on them.



On Fri, Mar 13, 2026 at 10:04 AM Daniel Anglin <Daniel.Anglin@aqualab.com>
wrote:

> Hey Ed,
>
> It was good speaking with you again yesterday!
>
> Here are the resources I mentioned. I've attached an example isotherm
> report and gummy application note.
> Cracking the Water Problem in Gummies
> <https://us-9893.email-composer-webhooks.gong.io/email-tracking/clicked?email-info-token=eyJhbGciOiJIUzI1NiJ9.eyJjb21wYW55SWQiOiIzOTUwNTMxMzIyOTM4Nzk1MDg5IiwiZHJhZnRJZCI6InItNzQ0ODc2MjI5NDU0NjUxNTMwMSIsImxpbmtVcmwiOiJodHRwczovL3ZpZXcuaGlnaHNwb3QuY29tL3ZpZXdlci9kYjU4ZjNkYzk4ZjcwYmQzNzI3OTcyYjhkMTU0ZmU4ZCIsImxpbmtUZXh0IjoiQ3JhY2tpbmcgdGhlIFdhdGVyIFByb2JsZW0gaW4gR3VtbWllcyIsInRlbXBsYXRlSWQiOiIiLCJleHAiOjE3NzUyMzU4ODQsImlhdCI6MTc3MzQyMTQ4NCwianRpIjoicTg3a2trd3F3L3g3In0.8OlfrvfPY6KDcefsWtZuscXeP5SeH-AiOzJQ-cU3Pd4>
>
> Isotherms and Food Stability
> <https://us-9893.email-composer-webhooks.gong.io/email-tracking/clicked?email-info-token=eyJhbGciOiJIUzI1NiJ9.eyJjb21wYW55SWQiOiIzOTUwNTMxMzIyOTM4Nz
…[truncated 3660 chars]
```

**Drafted reply:**

```
Hi Daniel,  

I’ve reviewed the quotes and the attached documents. The isotherm report and application note are helpful, thanks.  

We’re looking to schedule a time next week for the meeting with Dr. Cartwright. I’ll check my calendar and get back to you with options.  

Also, the quotes are expired — can we confirm the current expiration dates and if they need to be renewed?  

— Heron Labs
```

---

### Draft 116 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 19:31)

**From:** `sagar@getflightmode.com` → `eddie@heronlabsinc.com`  
**Subject:** Re: Flightmode

**Inbound body:**

```
Please see attached, I thought we had agreed to 1000mcg b12 and 5mg b6
And for sleep the phosphatstyrene I had said 150mg.

Those are small changes though, other than that we are good to go

Sagar Govani

Head of Marketing | Flightmode

📞+1 (703) 939-0707✉️sagar@getflightmode.com🌐 https://getflightmode.com

Sent from [Proton Mail](https://proton.me/mail/home) for iOS.

-------- Original Message --------
On Wednesday, 05/13/26 at 15:14 Edward Riggins <eddie@heronlabsinc.com> wrote:

> I will follow up with the nutritional information, we're checking the rounding math on a couple values.
>
> WAKE	per serving
> Green Coffee Bean 98% Caffeine	150mg
> L-Theanine	100mg
> Lion's Mane 10:1	800mg
> B6	500mcg
> B9	400mcg
> B12	2.4mcg
> D3	600iu/5mcgOther Ingredients: Cane Sugar, Tapioca Isomalto-Oligosaccharides, Pectin, Citric Acid, Vegetable Juice (color), Monk Fruit Extract, Orange Oil, Natural Strawberry Flavor, Natural Guava Flavor and Other Natural Flavors, MCT Oil
>
> SLEEP	per serving
> Chamomile 10:1	100mg
> Magnesium Glycinate	200mg
> French Maritime Pine Bark Extract (Pinus pinaster)	150mg
> PassionFlower Extract 10:1	35mg
> L-Theanine	35mg
> Vitamin C	500mg
> Phosphatidylserine	3
…[truncated 21780 chars]
```

**Drafted reply:**

```
Sagar, thanks for the update. The changes you mentioned are minor, but I’ll double-check the B12 and B6 values to confirm they’re correct. We’re ready to move forward once we have the final nutrition facts and formula. — Heron Labs
```

---

### Draft 115 — `internal` / `local` / `qwen3:4b-ctx4k` (2026-05-13 19:16)

**From:** `eddie@heronlabsinc.com` → `sagar@getflightmode.com`  
**Subject:** Re: Flightmode

**Inbound body:**

```
I will follow up with the nutritional information, we're checking the
rounding math on a couple values.

WAKE per serving
Green Coffee Bean 98% Caffeine 150mg
L-Theanine 100mg
Lion's Mane 10:1 800mg
B6 500mcg
B9 400mcg
B12 2.4mcg
D3 600iu/5mcg
Other Ingredients: Cane Sugar, Tapioca Isomalto-Oligosaccharides, Pectin,
Citric Acid, Vegetable Juice (color), Monk Fruit Extract, Orange Oil,
Natural Strawberry Flavor, Natural Guava Flavor and Other Natural Flavors,
MCT Oil


SLEEP per serving
Chamomile 10:1 100mg
Magnesium Glycinate 200mg
French Maritime Pine Bark Extract (Pinus pinaster) 150mg
PassionFlower Extract 10:1 35mg
L-Theanine 35mg
Vitamin C 500mg
Phosphatidylserine 300mgOther Ingredients: Cane Sugar, Tapioca
Isomalto-Oligosaccharides, Pectin, Citric Acid, Soy Lecithin, Grape Skin
Extract and Carrot Juice (color), Monk Fruit Extract, Natural Blackberry
Flavor and Other Natural Flavors, MCT Oil

On Wed, May 13, 2026 at 9:51 AM Sagar Govani <sagar@getflightmode.com>
wrote:

> Can you send me the nutrition facts and formula in these
>
>
> Sagar Govani
>
> Head of Marketing | Flightmode
> 📞 +1 (703) 939-0707
> ✉️ sagar@getflightmode.com🌐 https://getflightmode.com
>
>
> Sent from Pro
…[truncated 18064 chars]
```

**Drafted reply:**

```
I'll send the nutritional information and formula as promised. The Wake gummy has a caffeine dose of 50mg per serving, and the Sleep gummy has 50mg of Vitamin C per serving. We're checking the rounding math on a couple values. 

I'll get the replacement shipment moving — [confirm with operator: ship date once warehouse confirms]. 

— Heron Labs
```

---

### Draft 113 — `follow_up` / `local` / `qwen3:4b-ctx4k` (2026-05-13 16:56)

**From:** `sagar@getflightmode.com` → `eddie@heronlabsinc.com`  
**Subject:** Re: Flightmode

**Inbound body:**

```
Can you send me the nutrition facts and formula in these

Sagar Govani

Head of Marketing | Flightmode

📞+1 (703) 939-0707✉️sagar@getflightmode.com🌐 https://getflightmode.com

Sent from [Proton Mail](https://proton.me/mail/home) for iOS.

-------- Original Message --------
On Monday, 05/11/26 at 15:53 Sagar Govani <sagar@getflightmode.com> wrote:

> Samples received, I’ll test on my end. Thank you for the turn around. Hopefully we can proceed with the big batch by Friday
>
> Can you send me the nutrition facts and formula in these?
>
> Sagar Govani
>
> Head of Marketing | Flightmode
>
> 📞+1 (703) 939-0707✉️sagar@getflightmode.com🌐 https://getflightmode.com
>
> Sent from [Proton Mail](https://proton.me/mail/home) for iOS.
>
> -------- Original Message --------
> On Sunday, 05/10/26 at 11:39 Edward Riggins <eddie@heronlabsinc.com> wrote:
>
>> Oh yes, it was dropped to our closest ups ship location and should be in the system.
>>
>> On Sat, May 9, 2026, 12:13 PM Sagar Govani <sagar@getflightmode.com> wrote:
>>
>>> Hey,
>>> Hope you’re having a good weekend. Was it shipped out?
>>>
>>> Sagar Govani
>>>
>>> Head of Marketing | Flightmode
>>>
>>> 📞+1 (703) 939-0707✉️sagar@getflightmode.c
…[truncated 19538 chars]
```

**Drafted reply:**

```
I’ll get the nutrition facts and formula to you today. The samples are in and we’re testing them. We’ll ship the big batch by Friday as planned. — Heron Labs
```

---

## POST-PR#81 (created >= 2026-05-14 UTC) (n=10)

### Draft 158 — `follow_up` / `local` / `qwen3-4b-ctx4k` (2026-05-16 02:26)

**From:** `shabegsh@gmail.com` → `jt@heronlabsinc.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Got it - thanks!

Signed copy attached.

Sherry

On Sat, May 16, 2026 at 10:10 AM Julie Tran <jt@heronlabsinc.com> wrote:

>
>
> On Fri, May 15, 2026, 19:09 Julie Tran <jt@heronlabsinc.com> wrote:
>
>> Hi Sherry,
>>
>> You'll be signing the bottom left side of the 2nd page of the NDA.
>>
>>
>> On Fri, May 15, 2026, 19:05 Sha <shabegsh@gmail.com> wrote:
>>
>>> Hi Julie,
>>>
>>> No worries at all and thanks again for your time earlier.
>>>
>>> Do you want me to sign and send over the NDA copy? I didn’t see a spot
>>> for my signature.
>>>
>>> I’ve also attached the ingredient list we went through on the screen
>>> share.
>>>
>>> Cheers,
>>> Sherry
>>>
>>> On Sat, May 16, 2026 at 9:53 AM Julie Tran <jt@heronlabsinc.com> wrote:
>>>
>>>> Hi Sherry,
>>>>
>>>> I just realized I called you Anna when saying bye. Sorry, I was
>>>> reviewing Anna's project right before our call.
>>>>
>>>> Heres the mutual NDA.
>>>>
>>>> Thanks!
>>>> Julie
>>>>
>>>> On Fri, May 15, 2026, 09:35 Sha <shabegsh@gmail.com> wrote:
>>>>
>>>>> Hi Julie,
>>>>>
>>>>> That's great and yes, today 6pm PST / tomorrow 9am SGT works.
>>>>>
>>>>> Would you be ok to send me an online meeting invite? I look forward to
>>>>> our 
…[truncated 2919 chars]
```

**Drafted reply:**

```
Sherry, the NDA is attached. I'll get the signing done and send it back to you. Let me know if you need anything else. — Heron Labs
```

---

### Draft 157 — `internal` / `local` / `qwen3-4b-ctx4k` (2026-05-16 02:11)

**From:** `jt@heronlabsinc.com` → `shabegsh@gmail.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Hi Sherry,

You'll be signing the bottom left side of the 2nd page of the NDA.


On Fri, May 15, 2026, 19:05 Sha <shabegsh@gmail.com> wrote:

> Hi Julie,
>
> No worries at all and thanks again for your time earlier.
>
> Do you want me to sign and send over the NDA copy? I didn’t see a spot for
> my signature.
>
> I’ve also attached the ingredient list we went through on the screen share.
>
> Cheers,
> Sherry
>
> On Sat, May 16, 2026 at 9:53 AM Julie Tran <jt@heronlabsinc.com> wrote:
>
>> Hi Sherry,
>>
>> I just realized I called you Anna when saying bye. Sorry, I was reviewing
>> Anna's project right before our call.
>>
>> Heres the mutual NDA.
>>
>> Thanks!
>> Julie
>>
>> On Fri, May 15, 2026, 09:35 Sha <shabegsh@gmail.com> wrote:
>>
>>> Hi Julie,
>>>
>>> That's great and yes, today 6pm PST / tomorrow 9am SGT works.
>>>
>>> Would you be ok to send me an online meeting invite? I look forward to
>>> our discussion.
>>>
>>> Thanks,
>>> Sherry
>>>
>>> On Sat, 16 May 2026, 12:26 am Julie Tran, <jt@heronlabsinc.com> wrote:
>>>
>>>> Hi Sherry,
>>>>
>>>> For R&D, the initial iteration usually takes about 1 week once we have
>>>> all ingredients and details. Subsequent iterations take a we
…[truncated 2451 chars]
```

**Drafted reply:**

```
Sherry, I see you've signed the NDA. Let me know when you're ready to move forward with the custom gummy supplement project. We're excited to collaborate and bring your product to market. — Heron Labs
```

---

### Draft 156 — `internal` / `local` / `qwen3-4b-ctx4k` (2026-05-16 02:11)

**From:** `jt@heronlabsinc.com` → `shabegsh@gmail.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
On Fri, May 15, 2026, 19:09 Julie Tran <jt@heronlabsinc.com> wrote:

> Hi Sherry,
>
> You'll be signing the bottom left side of the 2nd page of the NDA.
>
>
> On Fri, May 15, 2026, 19:05 Sha <shabegsh@gmail.com> wrote:
>
>> Hi Julie,
>>
>> No worries at all and thanks again for your time earlier.
>>
>> Do you want me to sign and send over the NDA copy? I didn’t see a spot
>> for my signature.
>>
>> I’ve also attached the ingredient list we went through on the screen
>> share.
>>
>> Cheers,
>> Sherry
>>
>> On Sat, May 16, 2026 at 9:53 AM Julie Tran <jt@heronlabsinc.com> wrote:
>>
>>> Hi Sherry,
>>>
>>> I just realized I called you Anna when saying bye. Sorry, I was
>>> reviewing Anna's project right before our call.
>>>
>>> Heres the mutual NDA.
>>>
>>> Thanks!
>>> Julie
>>>
>>> On Fri, May 15, 2026, 09:35 Sha <shabegsh@gmail.com> wrote:
>>>
>>>> Hi Julie,
>>>>
>>>> That's great and yes, today 6pm PST / tomorrow 9am SGT works.
>>>>
>>>> Would you be ok to send me an online meeting invite? I look forward to
>>>> our discussion.
>>>>
>>>> Thanks,
>>>> Sherry
>>>>
>>>> On Sat, 16 May 2026, 12:26 am Julie Tran, <jt@heronlabsinc.com> wrote:
>>>>
>>>>> Hi Sherry,
>>>>>
>>>>> For R&D, the 
…[truncated 2653 chars]
```

**Drafted reply:**

```
Hi Sherry,

Thanks for the update on the pilot run and budget. We’re happy to move forward.

The R&D timeline is as outlined — 1 week for the initial iteration, with subsequent iterations taking a week if no new materials are needed. We can definitely discuss the specifics of your pilot run and pricing.

I’ll schedule a call today or Monday 6-7pm PST. Let me know what works best.

— Heron Labs
```

---

### Draft 155 — `follow_up` / `local` / `qwen3-4b-ctx4k` (2026-05-16 02:06)

**From:** `shabegsh@gmail.com` → `jt@heronlabsinc.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Hi Julie,

No worries at all and thanks again for your time earlier.

Do you want me to sign and send over the NDA copy? I didn’t see a spot for
my signature.

I’ve also attached the ingredient list we went through on the screen share.

Cheers,
Sherry

On Sat, May 16, 2026 at 9:53 AM Julie Tran <jt@heronlabsinc.com> wrote:

> Hi Sherry,
>
> I just realized I called you Anna when saying bye. Sorry, I was reviewing
> Anna's project right before our call.
>
> Heres the mutual NDA.
>
> Thanks!
> Julie
>
> On Fri, May 15, 2026, 09:35 Sha <shabegsh@gmail.com> wrote:
>
>> Hi Julie,
>>
>> That's great and yes, today 6pm PST / tomorrow 9am SGT works.
>>
>> Would you be ok to send me an online meeting invite? I look forward to
>> our discussion.
>>
>> Thanks,
>> Sherry
>>
>> On Sat, 16 May 2026, 12:26 am Julie Tran, <jt@heronlabsinc.com> wrote:
>>
>>> Hi Sherry,
>>>
>>> For R&D, the initial iteration usually takes about 1 week once we have
>>> all ingredients and details. Subsequent iterations take a week as long as
>>> we don't have to acquire any additional materials.
>>>
>>> Your budget and quantity look reasonable for a pilot run. We can
>>> definitely discuss this further.
>>>
>>> I can
…[truncated 2174 chars]
```

**Drafted reply:**

```
Hi Sherry,  

I see you attached the ingredient list - great! I'll get that to the team.  

Regarding the NDA, I'll send you a copy to sign and then we can send it over.  

Let me know what works best for you today or Monday.  

— Heron Labs
```

---

### Draft 154 — `internal` / `local` / `qwen3-4b-ctx4k` (2026-05-16 01:56)

**From:** `jt@heronlabsinc.com` → `shabegsh@gmail.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Hi Sherry,

I just realized I called you Anna when saying bye. Sorry, I was reviewing
Anna's project right before our call.

Heres the mutual NDA.

Thanks!
Julie

On Fri, May 15, 2026, 09:35 Sha <shabegsh@gmail.com> wrote:

> Hi Julie,
>
> That's great and yes, today 6pm PST / tomorrow 9am SGT works.
>
> Would you be ok to send me an online meeting invite? I look forward to our
> discussion.
>
> Thanks,
> Sherry
>
> On Sat, 16 May 2026, 12:26 am Julie Tran, <jt@heronlabsinc.com> wrote:
>
>> Hi Sherry,
>>
>> For R&D, the initial iteration usually takes about 1 week once we have
>> all ingredients and details. Subsequent iterations take a week as long as
>> we don't have to acquire any additional materials.
>>
>> Your budget and quantity look reasonable for a pilot run. We can
>> definitely discuss this further.
>>
>> I can meet today or Monday 6-7pm PST. Does that work for you?
>>
>> Let me know what works best.
>>
>> Julie
>>
>> On Tue, May 12, 2026, 10:07 Sha <shabegsh@gmail.com> wrote:
>>
>>> Hi Julie,
>>>
>>> Thanks for sending this over -- love the flavor range and sugar-free
>>> base options. What's the average turnaround time for R&D and each iteration?
>>>
>>> I'm targeting 
…[truncated 1736 chars]
```

**Drafted reply:**

```
Hi Julie,  

I just realized I called you Anna when saying bye. Sorry, I was reviewing Anna's project right before our call.  

I'm Sherry, not Anna. Thanks for the NDA.  

I'm targeting a pilot run of 15,000 gummies and have allocated a budget of $12k - $15k to cover R&D and this first run.  

Launching one SKU in the US and if successful, other locations in the pipeline.  

Do you have any availability this week for a call? 6-8pm PST works on my end.  

— Heron Labs
```

---

### Draft 153 — `follow_up` / `local` / `qwen3-4b-ctx4k` (2026-05-16 01:16)

**From:** `dylan@voidsleep.us` → `jt@heronlabsinc.com`  
**Subject:** Re: Void sleep gummy

**Inbound body:**

```
Awesome I’m so excited about this! How did they taste?

On Fri, May 15, 2026 at 4:04 PM Julie Tran <jt@heronlabsinc.com> wrote:

> Hey Dylan,
>
> I tried a gummy last night. I had no grogginess at all in the morning. I'm
> in a high-stress era right now so this gummy really helped me get the sleep
> I need to recover and seize the day. I normally wake up multiple times
> during the night and also don't get this much REM.
>
>
>
>
> On Wed, May 13, 2026, 13:07 Dylan Hauver <dylan@voidsleep.us> wrote:
>
>> Ok sweet thanks for the update I'm excited to try them. Can you please
>> send me a final ingredients/dose w/ other ingredients list for me to make
>> the label? Also lmk when you ship please and send the tracking info.
>> Getting hot in phoenix I dont want them to melt in my mailbox.
>>
>> On Mon, May 11, 2026 at 5:50 PM Edward Riggins <eddie@heronlabsinc.com>
>> wrote:
>>
>>> Sorry about that - we had to pull in more apigenin, but the sample was
>>> cooked today and will ship by wed/thursday depending on how quickly it
>>> finishes drying. Here was the mock-up generated based on how the color was
>>> coming out in the last sample - i think this is still pretty accurate.
>>>
>>> On
…[truncated 57161 chars]
```

**Drafted reply:**

```
I'm glad to hear you're excited! The gummies taste great - they have a smooth, slightly sweet flavor with a hint of herbal. We'll send you the final ingredients list and dose info shortly. The shipment is scheduled for Thursday, and we'll send tracking once it's out. Stay cool in Phoenix! — Heron Labs
```

---

### Draft 152 — `internal` / `local` / `qwen3-4b-ctx4k` (2026-05-15 23:11)

**From:** `jt@heronlabsinc.com` → `dylan@voidsleep.us`  
**Subject:** Re: Void sleep gummy

**Inbound body:**

```
Hey Dylan,

I tried a gummy last night. I had no grogginess at all in the morning. I'm
in a high-stress era right now so this gummy really helped me get the sleep
I need to recover and seize the day. I normally wake up multiple times
during the night and also don't get this much REM.




On Wed, May 13, 2026, 13:07 Dylan Hauver <dylan@voidsleep.us> wrote:

> Ok sweet thanks for the update I'm excited to try them. Can you please
> send me a final ingredients/dose w/ other ingredients list for me to make
> the label? Also lmk when you ship please and send the tracking info.
> Getting hot in phoenix I dont want them to melt in my mailbox.
>
> On Mon, May 11, 2026 at 5:50 PM Edward Riggins <eddie@heronlabsinc.com>
> wrote:
>
>> Sorry about that - we had to pull in more apigenin, but the sample was
>> cooked today and will ship by wed/thursday depending on how quickly it
>> finishes drying. Here was the mock-up generated based on how the color was
>> coming out in the last sample - i think this is still pretty accurate.
>>
>> On Sun, May 10, 2026 at 8:25 PM Dylan Hauver <dylan@voidsleep.us> wrote:
>>
>>> Hey is the R&D almost done? You guys said in the call it would take
>>> about a wee
…[truncated 55759 chars]
```

**Drafted reply:**

```
Hey Dylan,  

I'm glad to hear the gummy worked well for you! The sleep quality feedback is super helpful.  

We're still working on the final color and will share a representative sample tomorrow.  

Let me know when you're available for the call - we want to make a final sample after the call.  

Thanks,  
Julie
```

---

### Draft 151 — `unknown` / `cloud` / `gpt-oss:120b` (2026-05-15 21:21)

**From:** `bidspotter@mail.bidspotter.com` → `dustin@heronlabsinc.com`  
**Subject:** Upcoming BidSpotter Auctions - Don't Miss Out

**Inbound body:**

```
Featured BidSpotter Auction - Sign Up To Bid!

[https://5poe2t9x.emltrk.com/v2/5poe2t9x?i=616897262&t=bs-general-nl]
 ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ 
 ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ 
 ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ 
 ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌ 

View in browser
[https://click.mail.bidspotter.com/?qs=ABB7InYiOjEsImQiOjQ4Nzd9AAoAAAAAAOMZkL6lj5Y7H0vE1nYvJLoXSKk1vuP9W46bc2fe-dEO5PSa6eaxwe1v9P__o8M5aTnwkhJyMS1UY2gIV6ytj3Uv85zh3RNqnjvSDh22raYD]



BidSpotter
[https://image.mail.bidspotter.com/lib/fe3b15707564057f7c1477/m/1/ced6bab0-5252-40a6-ba36-d6d220f958a4.png]https://click.mail.bidspotter.com/?qs=ABB7InYiOjEsImQiOjQ4Nzd9AAoAAAAAAOMZkL6md1rCcZDxqpPrbvMcrLh8b1Si96xePKQRVva-1gGkko5t764eiC0UuLuhb5Vs5LkY9dL2SBTd1-X_onsd_4mxKAWPVJmzL4XeyG2m2tuTwQ

BidSpotter
[https://image.mail.thesaleroom.com/lib/fe3e15707564057f7c1474/m/1/67112657-82e7-4e28-9341-dea4beb4e930.png]https://click.mail.bidspotter.com/?qs=ABB7InYiOjEsImQiOjQ4Nzd9AAoAAAAAAOMZkL6n3ylMKaTfdzbnjiKZV46LskvbfOc1_CDQ6uYdSJkCr8Yu05FrrdPGkfhn1y-Ym
…[truncated 24644 chars]
```

**Drafted reply:**

```
Hi,

Thanks for the heads‑up, but we don’t participate in auctions. Please remove us from your mailing list.

— Heron Labs
```

---

### Draft 150 — `scheduling` / `local` / `qwen3-4b-ctx4k` (2026-05-15 16:42)

**From:** `shabegsh@gmail.com` → `jt@heronlabsinc.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Hi Julie,

That's great and yes, today 6pm PST / tomorrow 9am SGT works.

Would you be ok to send me an online meeting invite? I look forward to our
discussion.

Thanks,
Sherry

On Sat, 16 May 2026, 12:26 am Julie Tran, <jt@heronlabsinc.com> wrote:

> Hi Sherry,
>
> For R&D, the initial iteration usually takes about 1 week once we have all
> ingredients and details. Subsequent iterations take a week as long as we
> don't have to acquire any additional materials.
>
> Your budget and quantity look reasonable for a pilot run. We can
> definitely discuss this further.
>
> I can meet today or Monday 6-7pm PST. Does that work for you?
>
> Let me know what works best.
>
> Julie
>
> On Tue, May 12, 2026, 10:07 Sha <shabegsh@gmail.com> wrote:
>
>> Hi Julie,
>>
>> Thanks for sending this over -- love the flavor range and sugar-free base
>> options. What's the average turnaround time for R&D and each iteration?
>>
>> I'm targeting a pilot run of 15,000 gummies and have allocated a budget
>> of $12k - $15k to cover R&D and this first run.
>>
>> Launching one SKU in the US and if successful, other locations in the
>> pipeline.
>>
>> Do you have any availability this week for a call? 6-8pm PST w
…[truncated 1410 chars]
```

**Drafted reply:**

```
Sherry, the 6-8pm PST time works for me. I'll send over the meeting invite shortly.  

— Heron Labs
```

---

### Draft 149 — `internal` / `local` / `qwen3-4b-ctx4k` (2026-05-15 16:32)

**From:** `jt@heronlabsinc.com` → `shabegsh@gmail.com`  
**Subject:** Re: Custom Gummy Supplement – Startup

**Inbound body:**

```
Hi Sherry,

For R&D, the initial iteration usually takes about 1 week once we have all
ingredients and details. Subsequent iterations take a week as long as we
don't have to acquire any additional materials.

Your budget and quantity look reasonable for a pilot run. We can definitely
discuss this further.

I can meet today or Monday 6-7pm PST. Does that work for you?

Let me know what works best.

Julie

On Tue, May 12, 2026, 10:07 Sha <shabegsh@gmail.com> wrote:

> Hi Julie,
>
> Thanks for sending this over -- love the flavor range and sugar-free base
> options. What's the average turnaround time for R&D and each iteration?
>
> I'm targeting a pilot run of 15,000 gummies and have allocated a budget of
> $12k - $15k to cover R&D and this first run.
>
> Launching one SKU in the US and if successful, other locations in the
> pipeline.
>
> Do you have any availability this week for a call? 6-8pm PST works on my
> end.
>
> Best regards,
> Sherry
>
> On Tue, 12 May 2026, 1:48 am Julie Tran, <jt@heronlabsinc.com> wrote:
>
>> Hi Sherry,
>>
>> We are located in California so may be easier for us to meet 7-11am
>> Singapore time /4-8pm PST.
>>
>> I've attached our standard R&D program. We d
…[truncated 1069 chars]
```

**Drafted reply:**

```
Hi Julie,  

I’m looking to launch a single SKU in the US initially, with potential for more locations if the first run is successful. I’m bootstrapping a supplement brand and have a clear list of actives for the custom formulation.  

I’m based in Singapore and generally available between 8-10am EST. I’d prefer an online meeting to discuss next steps.  

Thanks again,  
Sherry  

— Heron Labs
```

---
