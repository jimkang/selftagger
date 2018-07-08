/* global process, __dirname */

var config = require('./config');
// var config = require('./test-config');

var Twit = require('twit');
var waterfall = require('async-waterfall');
var queue = require('d3-queue').queue;
var randomId = require('idmaker').randomId;
var StaticWebArchiveOnGit = require('static-web-archive-on-git');
var request = require('request');
var sb = require('standard-bail')();
var postImage = require('post-image-to-twitter');
var probable = require('probable');
var callNextTick = require('call-next-tick');
var pluck = require('lodash.pluck');
var fs = require('fs');
var iscool = require('iscool')();

var dryRun = process.argv.length > 2 ? process.argv[2] === '--dry' : false;

var tagsToAvoid = [
  'font',
  'black and white',
  'ancient history',
  'history',
  'historic site',
  'monochrome',
  'monochrome photography',
  'still life photography',
  'photography',
  'aerial photography',
  'close up',
  'painting',
  'architecture',
  'mixed use',
  'residential area',
  'text'
];

const imgLinkRegex = /Size of this preview: <a href="([^"]+)\"(\s)/;
const apiURL =
  'https://vision.googleapis.com/v1/images:annotate?key=' +
  config.googleVisionAPIKey;

var staticWebStream = StaticWebArchiveOnGit({
  config: config.github,
  title: 'Self-tagging bot archives',
  footerScript: `<script type="text/javascript">
  (function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
  (i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
  })(window,document,'script','//www.google-analytics.com/analytics.js','ga');

  ga('create', 'UA-49491163-1', 'jimkang.com');
  ga('send', 'pageview');
</script>`,
  maxEntriesPerPage: 20
});

var twit = new Twit(config.twitter);
const maxTries = 5;
var tryCount = 0;

function attemptAPost() {
  waterfall([obtainImage, makeTagComment, postToTargets], wrapUp);
}

attemptAPost();

function obtainImage(done) {
  var reqOpts = {
    method: 'GET',
    url: 'http://commons.wikimedia.org/wiki/Special:Random/File'
  };
  request(reqOpts, sb(getImageFromPage, done));

  function getImageFromPage(res, body) {
    var result = imgLinkRegex.exec(body);
    if (!result || result.length < 1) {
      done(new Error(`Could not find image link for ${res.url}.`));
    } else {
      var imgLink = result[1];
      var imgReqOpts = {
        method: 'GET',
        url: imgLink,
        encoding: null
      };
      //console.log('imgLink', imgLink);
      request(imgReqOpts, sb(passBuffer, done));
    }
  }

  function passBuffer(res, buffer) {
    done(null, buffer);
  }
}

function makeTagComment(buffer, done) {
  var requestOpts = {
    url: apiURL,
    method: 'POST',
    json: true,
    body: createPostBody(buffer.toString('base64'))
  };
  request(requestOpts, sb(makeTagWithFeatures, done));

  function makeTagWithFeatures(res, body) {
    // console.log('body:', JSON.stringify(body, null, 2));
    var tags;
    var response = body.responses[0];
    var labels = pluck(response.labelAnnotations, 'description');
    var landmarks = pluck(response.landmarkAnnotations, 'description');
    var texts = pluck(response.textAnnotations, 'description');
    var quoteTheTag = false;
    if (texts.length > 1 && probable.roll(2) === 0) {
      tags = texts;
      console.log('text tags:', tags);
      quoteTheTag = true;
    } else if (landmarks.length > 0) {
      tags = landmarks;
    } else {
      tags = labels;
    }
    var tag = probable.pickFromArray(tags.filter(tagIsAllowed).filter(iscool));
    if (!tag) {
      done(new Error('Could not find suitable tags.'));
      return;
    }
    var comment;
    if (quoteTheTag) {
      comment = `tag ur self I'm "${tag}"`;
    } else {
      comment = `tag ur self I'm the ${tag}`;
    }
    done(null, { comment, tag, buffer });
  }
}

function createPostBody(base64encodedImage) {
  return {
    requests: [
      {
        image: {
          content: base64encodedImage
        },
        features: [
          {
            type: 'LABEL_DETECTION',
            maxResults: 100
          },
          {
            type: 'LANDMARK_DETECTION',
            maxResults: 5
          },
          {
            type: 'TEXT_DETECTION',
            maxResults: 10
          }
        ]
      }
    ]
  };
}

function postToTargets({ comment, tag, buffer }, done) {
  if (dryRun) {
    console.log('Would have posted:', comment);
    var filename = __dirname + '/scratch/' + tag + '.jpg';
    fs.writeFileSync(filename, buffer);
    console.log('Wrote', filename);
    callNextTick(done);
  } else {
    var q = queue();
    q.defer(postToArchive, { comment, tag, buffer });
    q.defer(postToTwitter, { comment, tag, buffer });
    q.await(done);
  }
}

function postToTwitter({ comment, tag, buffer }, done) {
  var postImageOpts = {
    twit,
    base64Image: buffer.toString('base64'),
    altText: tag,
    caption: comment
  };

  postImage(postImageOpts, done);
}

function postToArchive({ comment, tag, buffer }, done) {
  var id = tag.replace(/ /g, '-') + randomId(8);
  staticWebStream.write({
    id,
    date: new Date().toISOString(),
    mediaFilename: id + '.jpg',
    caption: comment,
    buffer
  });
  staticWebStream.end(done);
}

function wrapUp(error, data) {
  tryCount += 1;

  if (error) {
    console.log(error, error.stack);

    if (data) {
      console.log('data:', data);
    }

    if (tryCount < maxTries) {
      console.log(`Have tried ${tryCount} times. Retrying!`);
      callNextTick(attemptAPost);
    }
  } else {
    console.log('Completed successfully.');
  }
}

function tagIsAllowed(tag) {
  return tagsToAvoid.indexOf(tag) === -1;
}
